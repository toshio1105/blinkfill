// 割り当てロジックの実地テスト。模擬画面から読み取った欄（fields.sample.json）に対して、
// 3種類の入力で「保存済み → 名前一致 → Jev」の割り当てがどうなるかを確認する。
import fs from 'node:fs';
import { parseInput, makePlan, toSaved } from '../src/plan.js';

let raw = JSON.parse(fs.readFileSync(new URL('./fields.sample.json', import.meta.url), 'utf8'));
const fields = typeof raw === 'string' ? JSON.parse(raw) : raw;
const apiKey = (fs.readFileSync('C:/Users/toshi/Projects/jev-benchmark/.env', 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m) || [])[1]?.trim();
if (!apiKey) throw new Error('TYPESAFE_API_KEY が見つかりません');

const EXPECT = {
  '経費タイプ': '国内交通費（新幹線・特急）', '取引日': '2026-09-18', '出発地': '東京', '到着地': '新大阪',
  '金額（円）': '14720', '通貨': '日本円', '用務先': 'サンプル商事 大阪支店', '領収書区分': '電子領収書',
};

const cases = {
  'A. 英語キーのJSON（ラベルと名前が一致しない→Jevの出番）': JSON.stringify({
    expense_type: 'shinkansen', date: '2026-09-18', from: '東京', to: '新大阪', amount: 14720,
    currency: 'JPY', visit_to: 'サンプル商事 大阪支店', purpose: '蓄電池案件の定例打合せ', receipt: 'electronic', note: '往路のみ',
  }),
  'B. 日本語の「項目: 値」（名前一致だけで足りるはず）':
    '経費タイプ: 国内交通費（新幹線・特急）\n取引日: 2026/9/18\n出発地: 東京\n到着地: 新大阪\n金額: 14,720\n用務先: サンプル商事 大阪支店\n目的: 蓄電池案件の定例打合せ\n領収書区分: 電子',
  'C. 自由文': '9/18 新幹線 東京 新大阪 14720円 サンプル商事 電子領収書',
};

const show = (p) => `${String(p.label).padEnd(8, '　')} ← ${String(p.value).padEnd(22)} [${p.source}${p.source === 'jev' ? ' ' + Math.round(p.confidence * 100) + '%' : ''}]`;

for (const [name, text] of Object.entries(cases)) {
  const { records, structured } = parseInput(text);
  const t0 = performance.now();
  const { plan, jev } = await makePlan({ fields, entries: records[0], saved: {}, useJev: true, apiKey });
  const ms = Math.round(performance.now() - t0);
  console.log(`\n=== ${name}\n全体 ${ms}ms / Jev ${jev.ms}ms・${jev.requests}回 / ${plan.length}/${fields.length}欄`);
  plan.forEach((p) => console.log('  ' + show(p)));

  if (structured) {
    const saved = toSaved(fields, plan);
    const t1 = performance.now();
    const again = await makePlan({ fields, entries: records[0], saved, useJev: true, apiKey });
    console.log(`  → 対応表を保存して2回目: ${Math.round(performance.now() - t1)}ms / Jev ${again.jev.requests}回 / ${again.plan.length}欄`);
    if (name.startsWith('A')) {
      // 別の経費（タクシー）: 選択欄の値が初めてなので、その欄だけJevに聞くはず
      const taxi = parseInput(JSON.stringify({ expense_type: 'taxi', date: '2026-09-19', from: '新大阪駅', to: '中之島', amount: '2,340', currency: 'JPY', visit_to: 'サンプル商事 大阪支店', purpose: '定例打合せ', receipt: 'paper' })).records[0];
      const t2 = performance.now();
      const r3 = await makePlan({ fields, entries: taxi, saved, useJev: true, apiKey });
      console.log(`  → 別の経費（タクシー）: ${Math.round(performance.now() - t2)}ms / Jev ${r3.jev.requests}回`);
      r3.plan.forEach((p) => console.log('      ' + show(p)));
    }
  }
}
