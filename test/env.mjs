// テスト用のAPIキーの読み込み。環境変数を優先し、無ければ ENV_FILE（.env 形式）を読む。
// 例: ENV_FILE=../my-keys.env node test/plan-e2e.mjs
import fs from 'node:fs';
export function testKey(name) {
  if (process.env[name]) return process.env[name];
  const f = process.env.ENV_FILE;
  if (!f || !fs.existsSync(f)) return undefined;
  const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^\s*${name}\s*=\s*(.*?)\s*$`, 'm'));
  return m?.[1];
}
