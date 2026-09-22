// 貼り付けた内容の解釈と、入力計画（どの欄に何を入れるか）の組み立て。
// サイドパネルと Node のテストの両方から使う（chrome.* に依存しない）。

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const BATCH = 12;          // 1リクエストあたりの質問数
const MAX_OPTIONS = 40;    // これより選択肢が多い select は Jev に聞かず文字列一致で選ぶ
export const MIN_CONFIDENCE = 0.5;

const AMOUNT_LABEL = /金額|額|料金|運賃|代金|amount|price|cost/i;
function normalizeValue(field, value) {
  const v = String(value ?? '');
  if (field && field.type !== 'select' && AMOUNT_LABEL.test(field.label) && /^[¥￥]?[\d,.\s]+円?$/.test(v.trim())) {
    return v.replace(/[,，円¥￥\s]/g, '');
  }
  return v;
}

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-・:：()（）「」]/g, '');

// ---------------------------------------------------------------------------
// 入力の解釈
// 戻り値: { records: [[{key, value}]], structured: bool }
//   JSON 配列なら明細ごとに1レコード。structured=true の時だけ対応表を保存できる
// ---------------------------------------------------------------------------
export function parseInput(text) {
  const t = String(text ?? '').trim();
  if (!t) return { records: [], structured: false };

  try {
    const j = JSON.parse(t);
    const list = Array.isArray(j) ? j : [j];
    const records = list
      .filter((o) => o && typeof o === 'object')
      .map((o) => flatten(o).filter((e) => e.value !== '' && e.value != null));
    if (records.length) return { records, structured: true };
  } catch { /* JSON ではない */ }

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kv = lines.map((l) => l.match(/^([^:：\t=]{1,30})\s*[:：\t=]\s*(.+)$/));
  if (kv.length && kv.filter(Boolean).length >= Math.ceil(lines.length * 0.6)) {
    return { records: [kv.filter(Boolean).map((m) => ({ key: m[1].trim(), value: m[2].trim() }))], structured: true };
  }

  // 自由文: 区切り文字で断片に分ける
  const parts = t.split(/[\s、，]+/).map((s) => s.trim()).filter(Boolean);
  const year = new Date().getFullYear();
  return {
    records: [parts.map((p, i) => {
      const d = p.match(/^(?:(\d{4})[\/\-年.])?(\d{1,2})[\/\-月.](\d{1,2})日?$/);
      if (d) return { key: '日付', value: `${d[1] || year}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}` };
      if (/^[¥￥]?[\d,]+円?$/.test(p) && /[\d]{3,}|円|¥|￥/.test(p)) return { key: '金額', value: p };
      return { key: `断片${i + 1}`, value: p };
    })],
    structured: false,
  };
}

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) return flatten(v, key);
    return [{ key, value: Array.isArray(v) ? v.join(', ') : String(v) }];
  });
}

// ---------------------------------------------------------------------------
// 対応表（記憶した入力先）: 欄の signature → 入力のキー
// ---------------------------------------------------------------------------
export function applySaved(fields, entries, saved = {}) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const plan = [];
  for (const f of fields) {
    const key = saved[f.signature];
    if (key === '__none__') { plan.push({ id: f.id, skip: true, source: 'saved' }); continue; }
    const e = key && byKey.get(key);
    if (!e) continue;
    if (f.type === 'select') {
      const opt = saved[`${f.signature}#opt`]?.[e.value];
      if (opt) plan.push({ id: f.id, label: f.label, key: e.key, value: opt, confidence: 1, source: 'saved' });
      continue;   // 初めて見る値なら名前一致 / Jev に回す
    }
    plan.push({ id: f.id, label: f.label, key: e.key, value: e.value, confidence: 1, source: 'saved' });
  }
  return plan;
}

// AI を使わない一致判定: 欄のラベルと入力キーが文字列として一致・包含するか
export function matchByName(fields, entries, taken = new Set()) {
  const plan = [];
  for (const f of fields) {
    if (taken.has(f.id)) continue;
    const L = norm(f.label);
    if (!L) continue;
    const e = entries.find((x) => norm(x.key) === L)
      || entries.find((x) => norm(x.key).length >= 2 && (L.includes(norm(x.key)) || norm(x.key).includes(L)));
    if (e) plan.push({ id: f.id, label: f.label, key: e.key, value: e.value, entryValue: e.value, confidence: 0.9, source: 'name' });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Jev への問い合わせ
// 送るのは「入力内容」と「欄のラベル・種類・選択肢」だけ。画面の既存値は送らない
// ---------------------------------------------------------------------------
export function buildQuestions(fields, entries) {
  const questions = {};
  const decode = {};
  for (const f of fields) {
    if (f.type === 'select') {
      if (!f.options?.length || f.options.length > MAX_OPTIONS) continue;
      const criteria = {};
      f.options.forEach((o, i) => { criteria[`o${i}`] = o.text; decode[`${f.id}:o${i}`] = { value: o.text }; });
      criteria.none = '該当なし（この欄は変更しない）';
      questions[f.id] = {
        type: 'choice',
        instructions: `業務フォームの選択欄「${f.label}」で、入力内容に最も合う項目はどれか。入力内容から判断できなければ none。`,
        criteria,
      };
      if (entries.length) {
        const src = {};
        entries.forEach((e, i) => { src[`e${i}`] = `${e.key}: ${e.value}`; decode[`${f.id}__src:e${i}`] = e; });
        src.none = 'どれでもない（文脈から推測した）';
        questions[`${f.id}__src`] = {
          type: 'choice',
          instructions: `選択欄「${f.label}」を決める根拠になった入力項目はどれか。`,
          criteria: src,
        };
      }
    } else {
      const criteria = {};
      entries.forEach((e, i) => { criteria[`e${i}`] = `${e.key}: ${e.value}`; decode[`${f.id}:e${i}`] = e; });
      criteria.none = '該当なし（空欄のまま）';
      questions[f.id] = {
        type: 'choice',
        instructions: `業務フォームの入力欄「${f.label}」（形式: ${f.type}）に入れるべき値はどれか。対応する値が無ければ none。`,
        criteria,
      };
    }
  }
  return { questions, decode };
}

export async function askJev({ apiKey, fields, entries, fetchImpl = fetch }) {
  const { questions, decode } = buildQuestions(fields, entries);
  const state = '入力内容:\n' + entries.map((e) => `- ${e.key}: ${e.value}`).join('\n');
  const ids = Object.keys(questions);
  const chunks = [];
  let cur = [];
  for (const id of ids) {
    cur.push(id);
    if (cur.length >= BATCH && !questions[`${id}__src`]) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);

  const t0 = performance.now();
  const responses = await Promise.all(chunks.map(async (chunk) => {
    const res = await fetchImpl(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: Object.fromEntries(chunk.map((id) => [id, questions[id]])),
      }),
    });
    if (res.status === 401) throw new Error('JevのAPIキーが無効です');
    if (res.status === 429 || res.status === 529) throw new Error('Jevが混雑しています。少し待って再実行してください');
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }));
  const ms = Math.round(performance.now() - t0);

  const answers = Object.assign({}, ...responses.map((r) => r.answers ?? {}));
  const plan = [];
  for (const r of [{ answers }]) {
    for (const [id, a] of Object.entries(r.answers ?? {})) {
      if (id.endsWith('__src')) continue;
      if (!a || a.choice === 'none' || a.choice == null) continue;
      const d = decode[`${id}:${a.choice}`];
      if (!d) continue;
      const f = fields.find((x) => x.id === id);
      // 選択欄は選んだ項目名しか返らないので、元になった入力キーを文字列の近さで探す（対応表の保存用）
      const srcA = answers[`${id}__src`];
      const srcE = srcA && srcA.choice !== 'none' ? decode[`${id}__src:${srcA.choice}`] : null;
      const key = d.key ?? srcE?.key ?? entries.find((e) => {
        const a2 = norm(e.value), b2 = norm(d.value);
        return a2 && b2 && (a2 === b2 || a2.includes(b2) || b2.includes(a2));
      })?.key;
      const entryValue = key ? entries.find((e) => e.key === key)?.value : undefined;
      plan.push({ id, label: f?.label, key, value: d.value, entryValue, confidence: a.confidence ?? 0, source: 'jev' });
    }
  }
  return { plan, ms, requests: chunks.length };
}

// ---------------------------------------------------------------------------
// まとめ: 保存済み → 名前一致 → Jev の順で埋める
// ---------------------------------------------------------------------------
export async function makePlan({ fields, entries, saved, useJev, apiKey, fetchImpl }) {
  const plan = applySaved(fields, entries, saved);
  const done = new Set(plan.map((p) => p.id));

  const byName = matchByName(fields, entries, done);
  byName.forEach((p) => done.add(p.id));
  plan.push(...byName);

  let jev = { ms: 0, requests: 0 };
  const rest = fields.filter((f) => !done.has(f.id));
  if (useJev && apiKey && rest.length && entries.length) {
    const r = await askJev({ apiKey, fields: rest, entries, fetchImpl });
    plan.push(...r.plan);
    jev = { ms: r.ms, requests: r.requests };
  }
  const out = plan.filter((p) => !p.skip).map((p) => ({ ...p, value: normalizeValue(fields.find((f) => f.id === p.id), p.value) }));
  return { plan: out, jev };
}

// 入力した結果を対応表として保存する形に変換
export function toSaved(fields, plan, prev = {}) {
  const next = { ...prev };
  for (const p of plan) {
    const f = fields.find((x) => x.id === p.id);
    if (!f || !p.key || p.key.startsWith('断片')) continue;
    next[f.signature] = p.key;
    if (f.type === 'select' && p.entryValue != null) {
      next[`${f.signature}#opt`] = { ...(next[`${f.signature}#opt`] || {}), [p.entryValue]: p.value };
    }
  }
  return next;
}
