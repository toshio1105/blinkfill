// どのAIでも同じように割り当てられるか、送信内容に個人情報の値が入らないかを確かめる。
// キーは環境変数（TYPESAFE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY）から読む。
// 無い場合は ENV_FILE（.env 形式のファイル）を読む。キーの無いAIは飛ばす。
import fs from 'node:fs';
import { testKey } from './env.mjs';
import { makePlan, parseInput } from '../src/plan.js';
import { planProfile, derive } from '../src/profile.js';

const key = (k) => testKey(k);

const load = (f) => { const r = JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8')); return typeof r === 'string' ? JSON.parse(r) : r; };
const expenseFields = load('./fields.sample.json');
const profileFields = load('./profile-fields.sample.json').fields;

const PROFILE = {
  lastName: '山田', firstName: '太郎', lastNameKana: 'ヤマダ', firstNameKana: 'タロウ',
  email: 'taro@example.com', phone: '03-1234-5678', mobile: '090-1111-2222',
  postalCode: '1100001', prefecture: '東京都', city: '台東区谷中', street: '1-2-3', building: 'サンプルマンション101',
  company: 'サンプル商事', department: '営業部', birthday: '1990-01-15',
};
const expense = parseInput(JSON.stringify({ expense_type: 'shinkansen', date: '2026-09-18', from: '東京', to: '新大阪', amount: 14720, currency: 'JPY', visit_to: 'サンプル商事 大阪支店', purpose: '定例打合せ', receipt: 'electronic', note: '往路のみ' })).records[0];
const EXPECT = { '経費タイプ': '国内交通費（新幹線・特急）', '取引日': '2026-09-18', '出発地': '東京', '到着地': '新大阪', '金額（円）': '14720', '通貨': '日本円', '用務先': 'サンプル商事 大阪支店', '目的': '定例打合せ', '領収書区分': '電子領収書', '備考': '往路のみ' };

// SDK も含めて外への送信を全部記録する
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => { sent.push(String(init.body ?? '')); return realFetch(url, init); };

const CASES = [
  ['jev', 'TYPESAFE_API_KEY', 'jev-latest'],
  ['openai', 'OPENAI_API_KEY', 'gpt-5.6-luna'],
  ['anthropic', 'ANTHROPIC_API_KEY', 'claude-opus-5'],
  ['anthropic', 'ANTHROPIC_API_KEY', 'claude-haiku-4-5'],
  ['gemini', 'GEMINI_API_KEY', 'gemini-3.8-flash'],
];
for (const [provider, envName, model] of CASES) {
  const apiKey = key(envName);
  if (!apiKey) { console.log(`\n=== ${provider} / ${model}: キーが無いので飛ばす`); continue; }
  const ai = { provider, apiKey, model };
  console.log(`\n=== ${provider} / ${model}`);
  try {
    const t0 = performance.now();
    const e = await makePlan({ fields: expenseFields, entries: expense, saved: {}, ai });
    const ok = e.plan.filter((p) => EXPECT[p.label] === p.value).length;
    console.log(`  経費フォーム: ${ok}/${Object.keys(EXPECT).length}欄正解  ${Math.round(performance.now() - t0)}ms`);
    const bad = e.plan.filter((p) => EXPECT[p.label] !== p.value).map((p) => `${p.label}=${p.value}`);
    if (bad.length) console.log(`    違い: ${bad.join(' / ')}`);

    sent.length = 0;
    const t1 = performance.now();
    const pr = await planProfile({ fields: profileFields, profile: PROFILE, ai });
    const daytime = pr.plan.find((p) => p.label === '日中つながるご連絡先');
    console.log(`  会員登録: ${pr.plan.length}/${profileFields.length}欄  ${Math.round(performance.now() - t1)}ms  「日中つながるご連絡先」→ ${daytime ? daytime.value : '（空のまま）'}`);
    const leaked = Object.values(derive(PROFILE)).filter((v) => String(v).length >= 3 && sent.some((b) => b.includes(String(v))));
    console.log(leaked.length ? `  !! 個人情報の値が送られた: ${leaked.join(', ')}` : `  OK: 送信${sent.length}件に個人情報の値は含まれていない`);
  } catch (err) {
    console.log(`  エラー: ${err.message}`);
  }
}
