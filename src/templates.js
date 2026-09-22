// 定型入力: 決まった値（固定値）と、毎回変わる値（入力欄）と、そこから計算する値をひとまとめにした「ひな形」。
// ひな形の中身は利用者が JSON ファイルで読み込み、その人のChromeの中（chrome.storage.local）だけに置く。
// 拡張機能のコードには特定の会社・個人の値は入れない。
// サイドパネルと Node のテストの両方から使う（chrome.* に依存しない）。
//
// ひな形ファイルの形:
// {
//   "name": "セット名",
//   "templates": [{
//     "name": "ひな形名",
//     "fixed":    { "欄名": "値", ... },                         // そのまま入れる値
//     "fields":   [{ "key": "欄名", "type": "date|time|number|text|select",
//                    "default": "...", "defaultFrom": "空欄なら使う欄名", "options": [...],
//                    "fill": true, "hint": "..." }],
//     "computed": [{ "key": "欄名", "op": "...", ..., "fill": true }],   // 下の OPS を参照
//     "notes":    ["入力時の注意", ...]
//   }],
//   "list": { "date": ["欄名"], "times": ["欄名", ...] }      // 任意。複数日分の一覧から1行ずつ入れる（parseList）
// }
// 値が「✓」などのキーは、同じ名前のチェックボックスをオンにする（「無」「いいえ」などならオフ）。
// fill: false の欄・計算結果は画面には入れず、パネルに表示するだけ（コピー用のファイル名など）。

const TIME = /^(\d{1,2}):(\d{2})$/;

function toMinutes(v) {
  const m = String(v ?? '').trim().match(TIME);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fromMinutes(n) {
  const d = ((n % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`;
}
function toDate(v) {
  const m = String(v ?? '').match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}
// 画面に入れる日付の形（2026/02/10）
export function formatDate(v) {
  const d = toDate(v);
  if (!d) return String(v ?? '');
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 数値か、他の欄の名前（その欄の値を数値として使う）
function num(x, vals) {
  if (typeof x === 'number') return x;
  const v = vals[x];
  const n = Number(String(v ?? '').replace(/[,，円¥￥\s]/g, ''));
  return v == null || v === '' || Number.isNaN(n) ? null : n;
}

// 計算の種類。値が足りなければ null（その欄は空のまま）
const OPS = {
  // 時刻 ± 分: { from, add: [数値|欄名...], subtract: [数値|欄名...] }
  addMinutes(c, vals) {
    const base = toMinutes(vals[c.from]);
    if (base == null) return null;
    const add = [].concat(c.add ?? []).map((x) => num(x, vals));
    const sub = [].concat(c.subtract ?? []).map((x) => num(x, vals));
    if ([...add, ...sub].some((n) => n == null)) return null;
    return fromMinutes(base + add.reduce((a, b) => a + b, 0) - sub.reduce((a, b) => a + b, 0));
  },
  // 時刻の比較: { from, lte | gte: "HH:MM", then, else }
  compareTime(c, vals) {
    const t = toMinutes(vals[c.from]);
    if (t == null) return null;
    const hit = c.lte != null ? t <= toMinutes(c.lte) : t >= toMinutes(c.gte);
    return hit ? c.then : c.else;
  },
  // 日数（両端を含む）: { start, end }
  days(c, vals) {
    const a = toDate(vals[c.start]);
    const b = toDate(vals[c.end] || vals[c.start]);
    if (!a || !b || b < a) return null;
    return String(Math.round((b - a) / 86400000) + 1);
  },
  // 掛け算: { from, by }
  multiply(c, vals) {
    const a = num(c.from, vals);
    const b = num(c.by, vals);
    return a == null || b == null ? null : String(a * b);
  },
  // 文字列の組み立て: { template: "領収書_{出発地}→{到着地}.pdf" }
  format(c, vals) {
    let missing = false;
    const s = String(c.template ?? '').replace(/\{([^}]+)\}/g, (_, k) => {
      const v = vals[k];
      if (v == null || v === '') missing = true;
      return v ?? '';
    });
    return missing ? null : s;
  },
};
export const OP_NAMES = Object.keys(OPS);

// 読み込んだ JSON の検査。問題があれば Error を投げる
export function validateSet(json) {
  const set = typeof json === 'string' ? JSON.parse(json) : json;
  if (!set || typeof set !== 'object' || !Array.isArray(set.templates) || !set.templates.length) {
    throw new Error('ひな形ファイルの形が違います（templates の配列が必要です）');
  }
  if (!String(set.name ?? '').trim()) throw new Error('ひな形ファイルに name がありません');
  set.templates.forEach((t, i) => {
    const where = `${i + 1}番目のひな形`;
    if (!String(t?.name ?? '').trim()) throw new Error(`${where}に name がありません`);
    for (const f of t.fields ?? []) if (!f?.key) throw new Error(`${where}（${t.name}）: fields に key の無い項目があります`);
    for (const c of t.computed ?? []) {
      if (!c?.key) throw new Error(`${where}（${t.name}）: computed に key の無い項目があります`);
      if (!OPS[c.op]) throw new Error(`${where}（${t.name}）: 計算「${c.op}」は使えません（使えるもの: ${OP_NAMES.join(', ')}）`);
    }
  });
  return set;
}

// 入力値からの展開。
// 戻り値: { entries: 画面に入れる [{key, value}], display: 表示だけの [{key, value}], computed: 計算結果 [{key, value}] }
export function expand(template, inputs = {}) {
  const vals = { ...(template.fixed ?? {}) };
  const noFill = new Set();
  for (const f of template.fields ?? []) {
    let v = inputs[f.key] || f.default || '';
    if (!v && f.defaultFrom) v = vals[f.defaultFrom] ?? '';
    if (f.type === 'date' && v) v = formatDate(v);
    vals[f.key] = String(v).trim();
    if (f.fill === false) noFill.add(f.key);
  }
  const computed = [];
  for (const c of template.computed ?? []) {
    const v = OPS[c.op](c, vals);
    vals[c.key] = v ?? '';
    computed.push({ key: c.key, value: v ?? '' });
    if (c.fill === false) noFill.add(c.key);
  }
  const entries = [];
  const display = [];
  for (const [key, value] of Object.entries(vals)) {
    if (value === '' || value == null) continue;
    (noFill.has(key) ? display : entries).push({ key, value: String(value) });
  }
  return { entries, display, computed };
}

// ---------------------------------------------------------------------------
// 一覧（複数日分）: 「2/3(火) 出勤 8:47 退勤 21:27」のような行を貼っておき、1行ずつ選んで入れる。
// ひな形ファイルの "list": { "date": ["対象日", ...], "times": ["出勤時刻", "退勤時刻"], "hint": "..." }
//   各行の最初の日付を date の欄に、時刻を出てきた順に times の欄に入れる
// ---------------------------------------------------------------------------
const LIST_DATE = /(?:(\d{4})[\/\-年.])?(\d{1,2})[\/\-月.](\d{1,2})日?/;
const LIST_TIME = /(?<![\d:])(\d{1,2}:\d{2})(?![\d:])/g;

// 年の無い日付は、now に近い年にする（1月に12月分を処理しても前年になるように）
function withYear(y, m, d, now) {
  if (y) return `${y}/${m.padStart(2, '0')}/${d.padStart(2, '0')}`;
  let year = now.getFullYear();
  const t = new Date(year, Number(m) - 1, Number(d));
  if (t - now > 62 * 86400000) year -= 1;
  else if (now - t > 300 * 86400000) year += 1;
  return `${year}/${m.padStart(2, '0')}/${d.padStart(2, '0')}`;
}

export function parseList(list, text, now = new Date()) {
  if (!list) return [];
  const dates = [].concat(list.date ?? []);
  const times = [].concat(list.times ?? []);
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-・*●]+/, '').trim();
    const dm = line.match(LIST_DATE);
    if (!dm) continue;
    const values = {};
    const date = withYear(dm[1], dm[2], dm[3], now);
    dates.forEach((k) => { values[k] = date; });
    const rest = line.slice(dm.index + dm[0].length);
    [...rest.matchAll(LIST_TIME)].slice(0, times.length).forEach((m, i) => { values[times[i]] = m[1]; });
    rows.push({ label: line, values });
  }
  return rows;
}
