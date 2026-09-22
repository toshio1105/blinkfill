import { parseInput, makePlan, toSaved, MIN_CONFIDENCE } from './plan.js';
import { PROFILE_SCHEMA } from './profile.js';
import { loadProfiles, fillProfile } from './oneclick.js';
import { PROVIDERS } from './ai.js';
import { getAIConfig, saveAIConfig, activeAI } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let ai = null;          // 設定画面で編集中の AI 設定（getAIConfig の戻り値）
let scan = null;       // { tabId, mapKey, fields: [{...field, id: "frameId|fN", frameId, localId}], skipped }
let current = [];      // 表示中の計画

// --- 設定 -----------------------------------------------------------------
function renderAI() {
  $('providerList').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `
    <label class="prov ${ai.provider === id ? 'on' : ''}">
      <input type="radio" name="provider" value="${id}" ${ai.provider === id ? 'checked' : ''}>
      <span><span class="name">${esc(p.label)}</span><span class="desc">${esc(p.note)}</span></span>
      ${p.badge ? `<span class="rec">${esc(p.badge)}</span>` : ''}
    </label>`).join('');
  const p = PROVIDERS[ai.provider];
  $('keyLabel').textContent = `${p.label.replace(/（.*）/, '')} のAPIキー`;
  $('keyLink').href = p.keyUrl;
  $('apiKey').placeholder = p.keyHint;
  $('apiKey').value = ai.keys[ai.provider] || '';
  $('model').innerHTML = p.models.map((m) => `<option ${m === (ai.models[ai.provider] || p.models[0]) ? 'selected' : ''}>${m}</option>`).join('');
  $('jevTip').classList.toggle('hide', ai.provider === 'jev');
  $('aiBox').classList.toggle('dim', !ai.enabled);
  document.querySelectorAll('#providerList input').forEach((r) => {
    r.onchange = () => { keepEdits(); ai.provider = r.value; renderAI(); };
  });
}

// 画面上の入力（キー・モデル）を、編集中の設定に取り込む
function keepEdits() {
  ai.keys[ai.provider] = $('apiKey').value.trim();
  ai.models[ai.provider] = $('model').value;
  ai.enabled = $('useAI').checked;
}

async function loadSettings() {
  ai = await getAIConfig();
  $('useAI').checked = ai.enabled;
  renderAI();
  const s = await chrome.storage.local.get('lastInput');
  if (s.lastInput) $('input').value = s.lastInput;
  if (ai.enabled && !ai.apiKey) $('settings').classList.remove('hide');
}
$('toggleSettings').onclick = () => $('settings').classList.toggle('hide');
$('useAI').onchange = () => { keepEdits(); renderAI(); };
$('saveSettings').onclick = async () => {
  keepEdits();
  await saveAIConfig(ai);
  ai = await getAIConfig();
  const msg = !ai.enabled ? 'AIを使わない設定で保存しました'
    : ai.apiKey ? `設定を保存しました（${PROVIDERS[ai.provider].label}）`
    : `保存しました。${PROVIDERS[ai.provider].label} のAPIキーを入れてください`;
  $('profileStatus').className = 'status ' + (ai.enabled && !ai.apiKey ? 'res-ng' : 'res-ok');
  $('profileStatus').textContent = msg;
  status(msg, ai.enabled && !ai.apiKey ? 'res-ng' : 'res-ok');
};
$('forgetMap').onclick = async () => {
  const tab = await activeTab();
  const key = mapKeyOf(tab.url);
  await chrome.storage.local.remove(key);
  status('この画面の記憶を消しました');
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
    const aiNow = await activeAI();
    const { plan, ai: stats } = await makePlan({ fields, entries, saved, ai: aiNow });
    current = plan;
    currentProvider = aiNow?.provider;
    render();
    await markPreview();

    const total = Math.round(performance.now() - t0);
    const aiNote = stats.requests ? `（うち${PROVIDERS[aiNow.provider].label.replace(/（.*）/, '')} ${stats.ms}ms・${stats.requests}回）` : '';
    status(`${plan.length}/${fields.length}欄を割り当て ${total}ms${aiNote}`, 'res-ok');
  } catch (e) {
    status(e.message, 'res-ng');
  } finally {
    $('plan').disabled = false;
  }
};

let currentProvider = null;

function render() {
  const aiName = currentProvider ? PROVIDERS[currentProvider].label.replace(/（.*）/, '') : 'AI';
  const srcLabel = { saved: '記憶済み', name: '名前一致', ai: aiName };
  $('planCard').classList.remove('hide');
  $('planBody').innerHTML = current.map((p, i) => {
    const low = p.source === 'ai' && p.confidence < MIN_CONFIDENCE;
    // 確信度を返すのは Jev だけ。LLM の答えは一律の値なので % は出さない
    const conf = p.source === 'ai' && currentProvider === 'jev' ? ` ${Math.round(p.confidence * 100)}%` : '';
    return `<tr>
      <td><input type="checkbox" data-i="${i}" ${low ? '' : 'checked'}></td>
      <td>${esc(p.label)}</td>
      <td class="v">${esc(p.value)}</td>
      <td><span class="chip ${p.source} ${low ? 'low' : ''}">${srcLabel[p.source]}${conf}</span>
          <span id="r${i}"></span></td></tr>`;
  }).join('') || '<tr><td colspan="4">割り当てられる欄がありませんでした</td></tr>';

  const unassigned = scan.fields.length - current.length;
  const parts = [];
  if (unassigned > 0) parts.push(`未割り当て ${unassigned}欄`);
  if (scan.skipped.length) parts.push(`安全のため除外: ${scan.skipped.map((s) => `${s.label}（${s.reason}）`).join('、')}`);
  $('skipped').textContent = parts.join(' ／ ');
  $('remember').disabled = !scan.structured;
  $('remember').title = scan.structured ? '' : '「項目: 値」形式かJSONのときだけ記憶できます';
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
  status(`この画面の入力先を記憶しました（${Object.keys(next).length}欄）。次回はJevに問い合わせずに入力します。記憶はこのPCの中だけです`, 'res-ok');
};

$('clear').onclick = async () => {
  if (!scan) return;
  await chrome.scripting.executeScript({
    target: { tabId: scan.tabId, allFrames: true },
    func: () => window.__jevAF?.clearMarks(),
  }).catch(() => {});
};

// --- 個人情報（プロフィール） ----------------------------------------------
let editing = null;

async function refreshProfiles() {
  const { profiles, active } = await loadProfiles();
  $('profileSel').innerHTML = Object.keys(profiles)
    .map((n) => `<option ${n === active ? 'selected' : ''}>${esc(n)}</option>`).join('');
  return { profiles, active };
}

$('profileSel').onchange = () => chrome.storage.local.set({ activeProfile: $('profileSel').value });

$('fillProfile').onclick = async () => {
  $('fillProfile').disabled = true;
  try {
    const tab = await activeTab();
    if (!/^https?:/.test(tab.url || '')) throw new Error('このページでは使えません');
    const r = await fillProfile(tab.id, $('profileSel').value);
    $('profileStatus').className = 'status ' + (r.ok ? 'res-ok' : 'res-ng');
    $('profileStatus').textContent = r.message;
  } catch (e) {
    $('profileStatus').className = 'status res-ng';
    $('profileStatus').textContent = e.message;
  } finally {
    $('fillProfile').disabled = false;
  }
};

// 編集画面の並び。配列は2列に並べる組
const LAYOUT = [
  ['お名前', [['lastName', 'firstName'], ['lastNameKana', 'firstNameKana']]],
  ['連絡先', ['email', ['phone', 'mobile']]],
  ['住所', [['postalCode', 'prefecture'], 'city', 'street', 'building']],
  ['勤務先', ['company', ['department', 'jobTitle']]],
  ['その他', ['birthday']],
];
const TYPES = { email: 'email', phone: 'tel', mobile: 'tel', birthday: 'date' };

async function openEditor(name) {
  const { profiles, active } = await refreshProfiles();
  editing = name || active;
  const p = profiles[editing] || {};
  const byKey = Object.fromEntries(PROFILE_SCHEMA.map((f) => [f.key, f]));
  const field = (k) => {
    const f = byKey[k];
    return `<label class="field"><span class="lbl">${esc(f.label)}</span>
      <input type="${TYPES[k] || 'text'}" data-k="${k}" value="${esc(p[k] || '')}" placeholder="${f.example ? '例）' + esc(f.example) : ''}" autocomplete="off"></label>`;
  };
  $('profileTitle').textContent = `プロフィール：${editing}`;
  $('profileFields').innerHTML = LAYOUT.map(([title, rows]) => `
    <div class="group"><p class="group-title">${title}</p>
      ${rows.map((r) => (Array.isArray(r) ? `<div class="grid2">${r.map(field).join('')}</div>` : field(r))).join('')}
    </div>`).join('');
  $('profileEditor').classList.remove('hide');
  $('profileEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- タブ -------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-personal').classList.toggle('hide', name !== 'personal');
  $('tab-paste').classList.toggle('hide', name !== 'paste');
  chrome.storage.local.set({ lastTab: name });
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
chrome.storage.local.get('lastTab').then((s) => showTab(s.lastTab === 'paste' ? 'paste' : 'personal'));

$('editProfile2').onclick = () => openEditor($('profileSel').value);
$('editProfile').onclick = () => {
  $('settings').classList.add('hide');
  showTab('personal');
  openEditor();
};
$('closeProfile').onclick = () => $('profileEditor').classList.add('hide');

$('saveProfile').onclick = async () => {
  const { profiles } = await loadProfiles();
  const p = {};
  document.querySelectorAll('#profileFields input').forEach((i) => { if (i.value.trim()) p[i.dataset.k] = i.value.trim(); });
  profiles[editing] = p;
  await chrome.storage.local.set({ profiles, activeProfile: editing });
  await refreshProfiles();
  $('profileStatus').className = 'status res-ok';
  $('profileStatus').textContent = `「${editing}」を保存しました（${Object.keys(p).length}項目）`;
};

$('addProfile').onclick = async () => {
  const name = prompt('プロフィールの名前（例: 会社、家族）');
  if (!name?.trim()) return;
  const { profiles } = await loadProfiles();
  if (!profiles[name.trim()]) profiles[name.trim()] = {};
  await chrome.storage.local.set({ profiles, activeProfile: name.trim() });
  openEditor(name.trim());
};

$('delProfile').onclick = async () => {
  const { profiles } = await loadProfiles();
  if (Object.keys(profiles).length <= 1) { alert('最後の1つは削除できません'); return; }
  if (!confirm(`「${editing}」を削除しますか？`)) return;
  delete profiles[editing];
  await chrome.storage.local.set({ profiles, activeProfile: Object.keys(profiles)[0] });
  $('profileEditor').classList.add('hide');
  refreshProfiles();
};

loadSettings().then(refreshRecordPicker);
refreshProfiles();
