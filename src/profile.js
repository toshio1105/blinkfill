// 個人情報のワンクリック入力。
// 方針: 値（氏名・住所・電話など）は外に出さない。Jev に送るのは「欄の名前」と「項目名」だけ。
// 判定の順番: autocomplete 属性 → 欄の名前のパターン → 分割欄（郵便番号・電話・生年月日）→ Jev
// サイドパネル・バックグラウンド・Node のテストで共用（chrome.* に依存しない）。
import { askChoices } from './ai.js';

// 設定画面に出す項目（ユーザーが入力するもの）
export const PROFILE_SCHEMA = [
  { key: 'lastName', label: '姓（漢字）', example: '山田' },
  { key: 'firstName', label: '名（漢字）', example: '太郎' },
  { key: 'lastNameKana', label: 'セイ（カタカナ）', example: 'ヤマダ' },
  { key: 'firstNameKana', label: 'メイ（カタカナ）', example: 'タロウ' },
  { key: 'email', label: 'メールアドレス', example: 'taro@example.com' },
  { key: 'phone', label: '電話番号', example: '03-1234-5678' },
  { key: 'mobile', label: '携帯電話番号', example: '090-1234-5678' },
  { key: 'postalCode', label: '郵便番号', example: '110-0001' },
  { key: 'prefecture', label: '都道府県', example: '東京都' },
  { key: 'city', label: '市区町村', example: '台東区谷中' },
  { key: 'street', label: '番地', example: '1-2-3' },
  { key: 'building', label: '建物名・部屋番号', example: 'サンプルマンション101' },
  { key: 'company', label: '会社名', example: '' },
  { key: 'department', label: '部署名', example: '' },
  { key: 'jobTitle', label: '役職', example: '' },
  { key: 'birthday', label: '生年月日', example: '1990-01-15' },
];

// 入力に使う「派生した値」も含めた項目名（Jev に選択肢として渡すのはこの名前だけ）
export const TARGETS = {
  fullName: '氏名（姓名）', lastName: '姓', firstName: '名',
  fullNameKana: 'フリガナ（姓名・カタカナ）', lastNameKana: 'セイ（カタカナ）', firstNameKana: 'メイ（カタカナ）',
  fullNameHira: 'ふりがな（姓名・ひらがな）', lastNameHira: 'せい（ひらがな）', firstNameHira: 'めい（ひらがな）',
  email: 'メールアドレス', phone: '電話番号', mobile: '携帯電話番号',
  postalCode: '郵便番号', prefecture: '都道府県', city: '市区町村', street: '番地',
  building: '建物名・部屋番号', address: '住所（市区町村以降すべて）', fullAddress: '住所（都道府県から全部）',
  company: '会社名', department: '部署名', jobTitle: '役職', birthday: '生年月日',
};

const kata2hira = (s) => String(s ?? '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hira2kata = (s) => String(s ?? '').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const digits = (s) => String(s ?? '').normalize('NFKC').replace(/\D/g, '');

// プロフィールから、入力で使う全部の値を作る
export function derive(p = {}) {
  const v = { ...p };
  v.lastNameKana = hira2kata(p.lastNameKana);
  v.firstNameKana = hira2kata(p.firstNameKana);
  v.lastNameHira = kata2hira(v.lastNameKana);
  v.firstNameHira = kata2hira(v.firstNameKana);
  const join = (a, b) => [a, b].filter(Boolean).join(' ');
  v.fullName = join(p.lastName, p.firstName);
  v.fullNameKana = join(v.lastNameKana, v.firstNameKana);
  v.fullNameHira = join(v.lastNameHira, v.firstNameHira);
  v.address = [p.city, p.street, p.building].filter(Boolean).join(' ');
  v.fullAddress = [p.prefecture, p.city, p.street, p.building].filter(Boolean).join(' ');
  const z = digits(p.postalCode);
  if (z.length === 7) { v.postalCode = `${z.slice(0, 3)}-${z.slice(3)}`; v.postal1 = z.slice(0, 3); v.postal2 = z.slice(3); }
  for (const k of ['phone', 'mobile']) {
    const parts = String(p[k] ?? '').normalize('NFKC').split(/[-\s]/).filter(Boolean);
    if (parts.length === 3) [v[`${k}1`], v[`${k}2`], v[`${k}3`]] = parts;
  }
  const b = String(p.birthday ?? '').match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (b) {
    v.birthday = `${b[1]}-${b[2].padStart(2, '0')}-${b[3].padStart(2, '0')}`;
    v.birthYear = b[1]; v.birthMonth = String(Number(b[2])); v.birthDay = String(Number(b[3]));
  }
  for (const k of Object.keys(v)) if (v[k] === '' || v[k] == null) delete v[k];
  return v;
}

// --- 1. autocomplete 属性（付いていれば最も確実） --------------------------
const AUTOCOMPLETE = {
  'family-name': 'lastName', 'given-name': 'firstName', name: 'fullName',
  email: 'email', tel: 'phone', 'tel-national': 'phone',
  'postal-code': 'postalCode', 'address-level1': 'prefecture', 'address-level2': 'city',
  'address-line1': 'street', 'address-line2': 'building', 'street-address': 'address',
  organization: 'company', 'organization-title': 'jobTitle', bday: 'birthday',
  'bday-year': 'birthYear', 'bday-month': 'birthMonth', 'bday-day': 'birthDay',
};

// --- 2. 欄の名前のパターン（上から順に判定。具体的なものを先に） -------------
const RULES = [
  [/確認|再入力|もう一度|confirm/i, (f) => (/mail|メール/i.test(f.text) ? 'email' : null)],
  [/(セイ|姓).*(カナ|フリガナ)|(カナ|フリガナ).*(セイ|姓)|last.?name.?kana|kana.?(sei|last)/i, () => 'lastNameKana'],
  [/(メイ|名).*(カナ|フリガナ)|(カナ|フリガナ).*(メイ|名)|first.?name.?kana|kana.?(mei|first)/i, () => 'firstNameKana'],
  [/せい.*(かな|ふりがな)|(かな|ふりがな).*せい/, () => 'lastNameHira'],
  [/めい.*(かな|ふりがな)|(かな|ふりがな).*めい/, () => 'firstNameHira'],
  [/^セイ$/, () => 'lastNameKana'], [/^メイ$/, () => 'firstNameKana'],
  [/ふりがな|ひらがな/, () => 'fullNameHira'],
  [/フリガナ|カナ|kana|furigana/i, () => 'fullNameKana'],
  [/^姓|苗字|名字|last.?name|family.?name|surname|\bsei\b/i, () => 'lastName'],
  [/^名$|^名[（(]|first.?name|given.?name|\bmei\b/i, () => 'firstName'],
  [/氏名|お名前|名前|full.?name|^name$|your.?name/i, () => 'fullName'],
  [/e.?mail|メール/i, () => 'email'],
  [/携帯|mobile|cell/i, () => 'mobile'],
  [/電話|tel|phone|連絡先番号/i, () => 'phone'],
  [/郵便|〒|zip|postal|post.?code/i, () => 'postalCode'],
  [/都道府県|pref/i, () => 'prefecture'],
  [/市区町村|市町村|city/i, () => 'city'],
  [/番地|丁目|address.?1|street|住所1|住所１/i, () => 'street'],
  [/建物|マンション|ビル|部屋|address.?2|住所2|住所２/i, () => 'building'],
  [/住所|所在地|address/i, () => 'address'],
  [/会社|企業|法人|勤務先|勤め先|company|organi[sz]ation/i, () => 'company'],
  [/部署|所属|department|division/i, () => 'department'],
  [/役職|職位|job.?title|position/i, () => 'jobTitle'],
  [/生年月日|誕生日|birth/i, () => 'birthday'],
];

function textOf(f) {
  return [f.label, f.name, f.placeholder].filter(Boolean).join(' ');
}

function byRule(f) {
  if (f.autocomplete) {
    const tokens = f.autocomplete.toLowerCase().split(/\s+/);
    for (const t of tokens) if (AUTOCOMPLETE[t]) return AUTOCOMPLETE[t];
  }
  const text = textOf(f);
  for (const [re, fn] of RULES) {
    if (re.test(f.label) || re.test(f.name || '') || re.test(f.placeholder || '')) {
      const k = fn({ ...f, text });
      if (k) return k;
    }
  }
  return null;
}

// --- 3. 分割された欄（郵便番号 3+4、電話 3欄、生年月日 年/月/日） -------------
// 同じ項目と判定された欄が連続していたら、並び順で分ける
function splitGroups(fields, plan) {
  const out = new Map(plan);
  const runs = [];
  let cur = null;
  const SPLITTABLE = ['postalCode', 'phone', 'mobile', 'birthday'];
  // 2欄目以降のラベルが「－」「年」だけ、または空のことが多い（ラベルは先頭の欄にしか付かない）
  const bare = (f) => !f.label || /^[\s\-－ー―~〜()（）年月日]*$/.test(f.label) || /^\(無名の/.test(f.label);
  for (const f of fields) {
    const k = out.get(f.id);
    const max = cur?.key === 'postalCode' ? 2 : 3;
    if (cur && SPLITTABLE.includes(cur.key) && cur.ids.length < max && (k === cur.key || (!k && bare(f)))) {
      cur.ids.push(f.id);
      out.set(f.id, cur.key);
    } else {
      cur = k ? { key: k, ids: [f.id] } : null;
      if (cur) runs.push(cur);
    }
  }
  for (const r of runs) {
    if (r.key === 'postalCode' && r.ids.length === 2) { out.set(r.ids[0], 'postal1'); out.set(r.ids[1], 'postal2'); }
    if ((r.key === 'phone' || r.key === 'mobile') && r.ids.length === 3) r.ids.forEach((id, i) => out.set(id, `${r.key}${i + 1}`));
    if (r.key === 'birthday' && r.ids.length === 3) {
      ['birthYear', 'birthMonth', 'birthDay'].forEach((k, i) => out.set(r.ids[i], k));
    }
  }
  // ラベルに「年」「月」「日」だけ付いた生年月日のプルダウン
  for (const f of fields) {
    if (out.has(f.id)) continue;
    // 内部名は birth を含むときだけ見る（contact_daytime の "day" を誕生日と取り違えないため）
    const n = f.name || '';
    if (/^(年|year)$/i.test(f.label) || /birth.?(y|year)/i.test(n)) out.set(f.id, 'birthYear');
    else if (/^(月|month)$/i.test(f.label) || /birth.?(m|month)/i.test(n)) out.set(f.id, 'birthMonth');
    else if (/^(日|day)$/i.test(f.label) || /birth.?(d|day)/i.test(n)) out.set(f.id, 'birthDay');
  }
  return out;
}

// 欄の形式に合わせて値を整える（数字だけの欄、全角カナの欄など）
function fitValue(f, key, v) {
  let s = String(v);
  if (/^(phone|mobile)$/.test(key) && (f.maxLength && f.maxLength <= 11 || /ハイフンなし|ハイフン無|半角数字/.test(f.label + (f.placeholder || '')))) s = digits(s);
  if (key === 'postalCode' && (f.maxLength === 7 || /ハイフンなし|ハイフン無/.test(f.label + (f.placeholder || '')))) s = digits(s);
  if (f.type === 'date' && key === 'birthday') return s;
  return s;
}

// --- 4. まとめ -----------------------------------------------------------------
export function ruleMatch(fields, values) {
  const plan = new Map();
  for (const f of fields) {
    const k = byRule(f);
    if (k) plan.set(f.id, k);
  }
  return splitGroups(fields, plan);
}

export function buildProfileQuestions(fields) {
  const criteria = {};
  Object.entries(TARGETS).forEach(([k, label]) => { criteria[k] = label; });
  criteria.none = '個人情報の欄ではない（何も入れない）';
  const questions = {};
  for (const f of fields) {
    questions[f.id] = {
      type: 'choice',
      instructions: `Webフォームの入力欄「${f.label}」（形式: ${f.type}${f.placeholder ? `、例: ${f.placeholder}` : ''}）は、どの個人情報を入れる欄か。個人情報の欄でなければ none。`,
      criteria,
    };
  }
  return questions;
}

// ai: { provider, apiKey, model }（旧形式の { useJev, apiKey } も受け付ける）
export async function planProfile({ fields, profile, ai, useJev, apiKey, fetchImpl = fetch, minConfidence = 0.6 }) {
  if (!ai && useJev && apiKey) ai = { provider: 'jev', apiKey };
  const values = derive(profile);
  const byRuleMap = ruleMatch(fields, values);
  const plan = [];
  const rest = [];
  for (const f of fields) {
    const key = byRuleMap.get(f.id);
    if (key && values[key] != null) plan.push({ id: f.id, label: f.label, key, value: fitValue(f, key, values[key]), confidence: 1, source: 'rule' });
    else if (!key) rest.push(f);
  }

  let stats = { ms: 0, requests: 0 };
  if (ai?.apiKey && rest.length) {
    // state には値を入れない。「どんな項目があるか」だけを渡す（どのAIでも同じ）
    const { answers, ms, requests } = await askChoices({
      ...ai, fetchImpl,
      state: '日本語のWebフォーム。入力者の個人情報（氏名・連絡先・住所・勤務先・生年月日）を入れる。',
      questions: buildProfileQuestions(rest),
    });
    stats = { ms, requests };
    const aiMap = new Map();
    for (const f of rest) {
      const a = answers[f.id];
      if (a && a.choice && a.choice !== 'none' && a.choice in TARGETS && (a.confidence ?? 0) >= minConfidence) aiMap.set(f.id, { key: a.choice, conf: a.confidence });
    }
    // AI の結果も分割欄の処理にかける
    const merged = splitGroups(fields, new Map([...byRuleMap, ...[...aiMap].map(([id, x]) => [id, x.key])]));
    for (const f of rest) {
      const key = merged.get(f.id);
      if (key && values[key] != null && aiMap.has(f.id)) {
        plan.push({ id: f.id, label: f.label, key, value: fitValue(f, key, values[key]), confidence: aiMap.get(f.id).conf, source: 'ai' });
      }
    }
  }
  return { plan, ai: stats, jev: stats };
}
