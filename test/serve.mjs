// テスト用の静的サーバー。/ に模擬画面、/core.js に拡張機能の中核スクリプトを出す
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const routes = {
  '/': ['fixture.html', 'text/html; charset=utf-8'],
  '/core.js': ['../src/core.js', 'text/javascript; charset=utf-8'],
};
http.createServer((req, res) => {
  const r = routes[new URL(req.url, 'http://x').pathname];
  if (!r) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': r[1] });
  fs.createReadStream(path.join(dir, r[0])).pipe(res);
}).listen(5188, () => console.log('fixture on http://localhost:5188'));
