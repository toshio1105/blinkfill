import { parseInput, makePlan, toSaved, MIN_CONFIDENCE } from './plan.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let settings = { apiKey: '', useJev: true };
let scan = null;       // { tabId, mapKey, fields: [{...field, id: "frameId|fN", frameId, localId}], skipped }
let current = [];      // 表示中の計画

// --- 設定 -----------------------------------------------------------------
async function loadSettings() {
  const s = await chrome.storage.local.get(['apiKey', 'useJev', 'lastInput']);
  settings = { apiKey: s.apiKey || '', useJev: s.useJev !== false };
  $('apiKey').value = settings.apiKey;
  $('useJev').checked = settings.useJev;
  if (s.lastInput) $('input').value = s.lastInput;
  if (!settings.apiKey) $('settings').classList.remove('hide');
}
$('toggleSettings').onclick = () => $('settings').classList.toggle('hide');
$('saveSettings').onclick = async () => {
  settings = { apiKey: $('apiKey').value.trim(), useJev: $('useJev').checked };
  await chrome.storage.local.set(settings);
  status('設定を保存しました');
};
$('forgetMap').onclick = async () => {
  const tab = await activeTab();
  const key = mapKeyOf(tab.url);
  await chrome.storage.local.remove(key);
  status('この画面の対応表を消しました');
};

// 同じ画面なら URL 中の番号（伝票IDなど）が違っても同じ対応表を使う
function mapKeyOf(url) {
  try {
    const u = new URL(url);
    return 'map:' + u.origin + u.pathname.replace(/\d{3,}/g, '*').replace(/[0-9a-f]{16,}/gi, '*');
  } catch { return 'map:unknown'; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function status(msg, cls = '') {
  $('status').className = 'status ' + cls;
  $('status').textContent = msg;
}

// --- 明細の選択（JSON 配列のとき） -----------------------------------------
function records() { return parseInput($('input').value); }
function refreshRecordPicker() {
  const { records: rs } = records();
  $('recordRow').classList.toggle('hide', rs.length <= 1);
  $('record').innerHTML = rs.map((r, i) => {
    const hint = r.slice(0, 2).map((e) => e.value).join(' / ');
    return `<option value="${i}">${i + 1}: ${esc(hint)}</option>`;
  }).join('');
}
$('input').addEventListener('input', () => {
  refreshRecordPicker();
  chrome.storage.local.set({ lastInput: $('input').value });
});

// --- 読み取り → 割り当て ---------------------------------------------------
$('plan').onclick = async () => {
  const t0 = performance.now();
  $('plan').disabled = true;
  try {
    const parsed = records();
    const entries = parsed.records[Number($('record').value) || 0] || [];
    if (!entries.length) { status('入れる内容を貼り付けてください', 'res-ng'); return; }

    const tab = await activeTab();
    if (!/^https?:/.test(tab.url || '')) { status('このページでは使えません', 'res-ng'); return; }

    status('画面を読み取り中…');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/core.js'] });
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__jevAF?.scan(),
    });

    const fields = [];
    const skipped = [];
    for (const f of frames) {
      if (!f.result) continue;
      skipped.push(...f.result.skipped);
      for (const fld of f.result.fields) {
        fields.push({ ...fld, id: `${f.frameId}|${fld.id}`, frameId: f.frameId, localId: fld.id });
      }
    }
    if (!fields.length) { status('入力欄が見つかりませんでした', 'res-ng'); return; }

    const mapKey = mapKeyOf(tab.url);
    const saved = (await chrome.storage.local.get(mapKey))[mapKey] || {};
    scan = { tabId: tab.id, mapKey, fields, skipped, structured: parsed.structured };

    status(`${fields.length}欄を割り当て中…`);
    const { plan, jev } = await makePlan({
      fields, entries, saved, useJev: settings.useJev, apiKey: settings.apiKey,
    });
    current = plan;
    render();
    await markPreview();

    const total = Math.round(performance.now() - t0);
    const jevNote = jev.requests ? `（うちJev ${jev.ms}ms・${jev.requests}回）` : '';
    status(`${plan.length}/${fields.length}欄を割り当て ${total}ms${jevNote}`, 'res-ok');
  } catch (e) {
    status(e.message, 'res-ng');
  } finally {
    $('plan').disabled = false;
  }
};

function render() {
  const srcLabel = { saved: '保存済み', name: '名前一致', jev: 'Jev' };
  $('planCard').classList.remove('hide');
  $('planBody').innerHTML = current.map((p, i) => {
    const low = p.source === 'jev' && p.confidence < MIN_CONFIDENCE;
    const conf = p.source === 'jev' ? ` ${Math.round(p.confidence * 100)}%` : '';
    return `<tr>
      <td><input type="checkbox" data-i="${i}" ${low ? '' : 'checked'}></td>
      <td>${esc(p.label)}</td>
      <td class="v">${esc(p.value)}</td>
      <td><span class="chip ${p.source === 'saved' ? 'saved' : ''} ${low ? 'low' : ''}">${srcLabel[p.source]}${conf}</span>
          <span id="r${i}"></span></td></tr>`;
  }).join('') || '<tr><td colspan="4">割り当てられる欄がありませんでした</td></tr>';

  const unassigned = scan.fields.length - current.length;
  const parts = [];
  if (unassigned > 0) parts.push(`未割り当て ${unassigned}欄`);
  if (scan.skipped.length) parts.push(`安全のため除外: ${scan.skipped.map((s) => `${s.label}（${s.reason}）`).join('、')}`);
  $('skipped').textContent = parts.join(' ／ ');
  $('remember').disabled = !scan.structured;
  $('remember').title = scan.structured ? '' : '「項目: 値」形式かJSONのときだけ保存できます';
}

function selected() {
  return [...document.querySelectorAll('#planBody input[type=checkbox]:checked')].map((c) => current[Number(c.dataset.i)]);
}

function byFrame(items) {
  const m = new Map();
  for (const p of items) {
    const f = scan.fields.find((x) => x.id === p.id);
    if (!f) continue;
    if (!m.has(f.frameId)) m.set(f.frameId, []);
    m.get(f.frameId).push({ ...p, id: f.localId, globalId: p.id });
  }
  return m;
}

async function markPreview() {
  for (const [frameId, items] of byFrame(current)) {
    await chrome.scripting.executeScript({
      target: { tabId: scan.tabId, frameIds: [frameId] },
      func: (a) => window.__jevAF?.preview(a),
      args: [items.map((p) => ({ id: p.id, confidence: p.confidence }))],
    }).catch(() => {});
  }
}

// --- 入力（送信はしない） -------------------------------------------------
$('fill').onclick = async () => {
  if (!scan) return;
  const items = selected();
  let ok = 0, ng = 0;
  for (const [frameId, list] of byFrame(items)) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: scan.tabId, frameIds: [frameId] },
      func: (a) => window.__jevAF?.fill(a),
      args: [list.map((p) => ({ id: p.id, value: p.value }))],
    });
    (res?.result || []).forEach((r, k) => {
      const idx = current.indexOf(current.find((c) => c.id === list[k].globalId));
      const good = r.status.startsWith('ok');
      good ? ok++ : ng++;
      const cell = $(`r${idx}`);
      if (cell) cell.innerHTML = good ? ' <span class="res-ok">✓</span>' : ` <span class="res-ng">✗ ${esc(r.status)}</span>`;
    });
  }
  status(`入力 ${ok}件${ng ? `・失敗 ${ng}件` : ''}。内容を確認して、保存・提出はご自身で。`, ng ? 'res-ng' : 'res-ok');
};

$('remember').onclick = async () => {
  if (!scan?.structured) return;
  const prev = (await chrome.storage.local.get(scan.mapKey))[scan.mapKey] || {};
  const next = toSaved(scan.fields, selected(), prev);
  await chrome.storage.local.set({ [scan.mapKey]: next });
  status(`対応表を保存しました（${Object.keys(next).length}欄）。次回からこの画面はJevなしで入ります`, 'res-ok');
};

$('clear').onclick = async () => {
  if (!scan) return;
  await chrome.scripting.executeScript({
    target: { tabId: scan.tabId, allFrames: true },
    func: () => window.__jevAF?.clearMarks(),
  }).catch(() => {});
};

loadSettings().then(refreshRecordPicker);
