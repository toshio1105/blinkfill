// 定型入力（ひな形の展開と計算）のテスト。外部通信なし: node test/templates-test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { validateSet, expand, formatDate, parseList } from '../src/templates.js';

const set = validateSet(fs.readFileSync(new URL('../examples/templates-sample.json', import.meta.url), 'utf8'));
const [train, allowance] = set.templates;
const obj = (list) => Object.fromEntries(list.map((e) => [e.key, e.value]));

// 固定値＋入力値が入る欄になり、fill:false の計算結果は表示だけになる
{
  const r = expand(train, { 取引日: '2026-9-8', 出発地: '東京', 到着地: '新大阪', 金額: '14,720' });
  const e = obj(r.entries);
  assert.equal(e['取引日'], '2026/09/08');
  assert.equal(e['経費タイプ'], '国内交通費（新幹線・特急）');
  assert.equal(e['金額'], '14,720');
  assert.equal(e['用務先'], undefined, '空の入力は入れない');
  assert.equal(e['領収書のファイル名'], undefined);
  assert.equal(obj(r.display)['領収書のファイル名'], '領収書_東京→新大阪.pdf');
}

// 時刻の足し引き・しきい値・日数・掛け算・defaultFrom
{
  const r = expand(allowance, { 出発日: '2026-02-10', 列車の出発時刻: '08:30', 列車の到着時刻: '17:31' });
  const e = obj(r.entries);
  const d = obj(r.display);
  assert.equal(e['帰着日'], '2026/02/10', '帰着日が空なら出発日');
  assert.equal(e['出発時刻'], '08:00');
  assert.equal(e['早出'], '有', '08:00 は 08:00 以前');
  assert.equal(e['帰着時刻'], '18:01');
  assert.equal(e['遅着'], '有');
  assert.equal(d['日数'], '1');
  assert.equal(d['手当額の目安（円）'], '1000');
  assert.equal(e['列車の出発時刻'], undefined, 'fill:false の入力欄は画面に入れない');
}
{
  const r = expand(allowance, { 出発日: '2026/2/10', 帰着日: '2026/2/12', 列車の出発時刻: '8:31', 列車の到着時刻: '17:29' });
  const e = obj(r.entries);
  assert.equal(e['出発時刻'], '08:01');
  assert.equal(e['早出'], '無');
  assert.equal(e['遅着'], '無');
  assert.equal(obj(r.display)['手当額の目安（円）'], '3000');
}
// 足りない値があれば計算しない（空のまま）
{
  const r = expand(allowance, { 出発日: '2026/2/10' });
  const e = obj(r.entries);
  assert.equal(e['出発時刻'], undefined);
  assert.equal(e['早出'], undefined);
}
// 日付をまたぐ時刻
{
  const t = { name: 't', fields: [{ key: 'a', type: 'time' }], computed: [{ key: 'b', op: 'addMinutes', from: 'a', subtract: [30] }] };
  assert.equal(obj(expand(t, { a: '00:10' }).entries).b, '23:40');
}
assert.equal(formatDate('2026年3月5日'), '2026/03/05');

// 一覧（複数日分）
{
  const list = { date: ['対象日', '対象期間'], times: ['出勤時刻', '退勤時刻'] };
  const text = '- 2/3(火) 出勤 8:47 退勤 21:27\n- 2/4(水) 出勤 8:52 退勤 19:29\n2/7(土)\n見出し行\n・2026/12/28 9:04 19:03';
  const rows = parseList(list, text, new Date(2026, 2, 5));
  assert.equal(rows.length, 4, '日付の無い行は飛ばす');
  assert.deepEqual(rows[0].values, { 対象日: '2026/02/03', 対象期間: '2026/02/03', 出勤時刻: '8:47', 退勤時刻: '21:27' });
  assert.deepEqual(rows[2].values, { 対象日: '2026/02/07', 対象期間: '2026/02/07' }, '時刻の無い日は日付だけ');
  assert.equal(rows[3].values['対象日'], '2026/12/28', '年があればそのまま');
  // 年の無い12月分を1月に処理したら前年
  assert.equal(parseList(list, '12/26 9:00 18:00', new Date(2027, 0, 10))[0].values['対象日'], '2026/12/26');
  assert.deepEqual(parseList(null, text), []);
}

// 検査
assert.throws(() => validateSet({ name: 'x', templates: [] }), /templates/);
assert.throws(() => validateSet({ name: 'x', templates: [{ name: 'a', computed: [{ key: 'k', op: 'eval' }] }] }), /eval/);
assert.throws(() => validateSet('{"templates":[{"name":"a"}]}'), /name/);

// 手元のひな形ファイルも検査したいとき: TEMPLATES=path/to/file.json node test/templates-test.mjs
if (process.env.TEMPLATES) {
  const own = validateSet(fs.readFileSync(process.env.TEMPLATES, 'utf8'));
  console.log(`${own.name}: ${own.templates.length}件のひな形`);
}
console.log('templates-test: ok');
