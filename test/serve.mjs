// テスト用の静的サーバー。/ に模擬画面、/core.js に拡張機能の中核スクリプトを出す
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const routes = {
  '/': ['fixture.html', 'text/html; charset=utf-8'],
  '/core.js': ['../src/core.js', 'text/javascript; charset=utf-8'],
  '/profile': ['profile.html', 'text/html; charset=utf-8'],
  '/kintai': ['kintai.html', 'text/html; charset=utf-8'],
};
// サイドパネルの画面テスト用: chrome.* を模擬してから本物の sidepanel.html を出す
const CHROME_STUB = `<base href="/src/"><script>
  const store = {};
  window.chrome = {
    storage: { local: {
      get: async (k) => { const ks = k == null ? Object.keys(store) : [].concat(k); return Object.fromEntries(ks.filter((x) => x in store).map((x) => [x, store[x]])); },
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
      remove: async (k) => { [].concat(k).forEach((x) => delete store[x]); },
    } },
    tabs: { query: async () => [{ id: 1, url: 'http://localhost:5188/profile' }] },
    scripting: { executeScript: async () => [] },
  };
  window.__store = store;
</script>`;

http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/panel') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(dir, '../src/sidepanel.html'), 'utf8').replace('<head>', '<head>' + CHROME_STUB));
  }
  if (pathname.startsWith('/src/') || pathname.startsWith('/vendor/')) {
    const f = path.join(dir, '..', pathname);
    const root = path.join(dir, '..', pathname.split('/')[1]);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const t = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(f)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': t + '; charset=utf-8' });
    return fs.createReadStream(f).pipe(res);
  }
  const r = routes[pathname];
  if (!r) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': r[1] });
  fs.createReadStream(path.join(dir, r[0])).pipe(res);
}).listen(5188, () => console.log('fixture on http://localhost:5188'));
