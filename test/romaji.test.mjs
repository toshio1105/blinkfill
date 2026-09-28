// ローマ字・英字指定の欄には入力しないことの確認（AIなし・ネットワークなし）
import assert from 'node:assert/strict';
import { planProfile } from '../src/profile.js';

const f = (id, label, section, name = '') => ({ id, label, section, name, type: 'text', autocomplete: '', placeholder: '', maxLength: 0 });
const fields = [
  f('f1', '市区町村', '住所', 'city'),
  f('f2', '丁目番地', '住所', 'street'),
  f('f3', '建物名', '住所', 'building'),
  f('f4', '市区町村', '住所(ローマ字)', 'city_r'),
  f('f5', '丁目番地', '住所(ローマ字)', 'street_r'),
  f('f6', '姓', 'お名前(ローマ字)', 'sei_r'),
  f('f7', '姓', 'お名前', 'sei'),
  f('f8', 'お名前（英字）', '', 'name_en'),
  f('f9', 'Last name in English', '', 'last_en'),
  f('f10', '氏名', 'ヘボン式ローマ字でご記入ください', 'name_hebon'),
];
const profile = { lastName: '山田', firstName: '太郎', city: '台東区谷中', street: '1-1-26', building: 'サンプル101' };

const { plan } = await planProfile({ fields, profile, ai: null });
const filled = new Set(plan.map((p) => p.id));

for (const id of ['f1', 'f2', 'f3', 'f7']) assert.ok(filled.has(id), `${id} は入力されるべき`);
for (const id of ['f4', 'f5', 'f6', 'f8', 'f9', 'f10']) assert.ok(!filled.has(id), `${id}（ローマ字・英字指定）は入力してはいけない`);

console.log(`OK: 日本語の欄 ${['f1','f2','f3','f7'].length}件に入力、ローマ字・英字の欄 ${['f4','f5','f6','f8','f9','f10'].length}件は空のまま`);
