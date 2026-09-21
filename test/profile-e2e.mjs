// 個人情報のワンクリック入力: 割り当てのテスト（架空のプロフィールを使う）
import fs from 'node:fs';
import { planProfile, derive } from '../src/profile.js';

let raw = JSON.parse(fs.readFileSync(new URL('./profile-fields.sample.json', import.meta.url), 'utf8'));
const { fields, skipped } = typeof raw === 'string' ? JSON.parse(raw) : raw;
const apiKey = (fs.readFileSync('C:/Users/toshi/Projects/jev-benchmark/.env', 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m) || [])[1]?.trim();

export const PROFILE = {
  lastName: '山田', firstName: '太郎', lastNameKana: 'やまだ', firstNameKana: 'タロウ',
  email: 'taro@example.com', phone: '03-1234-5678', mobile: '090-1111-2222',
  postalCode: '1100001', prefecture: '東京都', city: '台東区谷中', street: '1-2-3', building: 'サンプルマンション101',
  company: 'サンプル商事', department: '営業部', birthday: '1990-01-15',
};

// Jev に送る本文に、プロフィールの値が含まれていないことを確かめるための fetch
const sent = [];
const spyFetch = (url, init) => { sent.push(init.body); return fetch(url, init); };

const t0 = performance.now();
const { plan, jev } = await planProfile({ fields, profile: PROFILE, useJev: true, apiKey, fetchImpl: spyFetch });
console.log(`全体 ${Math.round(performance.now() - t0)}ms / Jev ${jev.ms}ms・${jev.requests}回 / ${plan.length}/${fields.length}欄に割り当て`);
for (const f of fields) {
  const p = plan.find((x) => x.id === f.id);
  console.log(`  ${f.label.padEnd(14, '　')} ${p ? `← ${p.value}  [${p.source}${p.source === 'jev' ? ' ' + Math.round(p.confidence * 100) + '%' : ''}]` : '（空のまま）'}`);
}
console.log('除外:', skipped.map((s) => `${s.label}(${s.reason})`).join(', '));

const leaked = Object.values(derive(PROFILE)).filter((v) => String(v).length >= 3 && sent.some((b) => b.includes(String(v))));
console.log(leaked.length ? `!! Jevに値が送られている: ${leaked.join(', ')}` : `OK: Jevに送った${sent.length}リクエストに個人情報の値は含まれていない`);
fs.writeFileSync(new URL('./profile-plan.tmp.json', import.meta.url), JSON.stringify(plan));
