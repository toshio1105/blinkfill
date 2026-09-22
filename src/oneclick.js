// 個人情報のワンクリック入力（サイドパネルのボタンとショートカットの両方から呼ぶ）
import { planProfile } from './profile.js';
import { activeAI } from './config.js';

export async function loadProfiles() {
  const s = await chrome.storage.local.get(['profiles', 'activeProfile']);
  const profiles = s.profiles || { 個人: {} };
  const active = profiles[s.activeProfile] ? s.activeProfile : Object.keys(profiles)[0];
  return { profiles, active };
}

export async function fillProfile(tabId, profileName) {
  const t0 = performance.now();
  const { profiles, active } = await loadProfiles();
  const name = profileName || active;
  const profile = profiles[name] || {};
  if (!Object.values(profile).some(Boolean)) {
    return { ok: false, message: `プロフィール「${name}」が空です。設定から登録してください` };
  }
  const ai = await activeAI();

  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/core.js'] });
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => window.__jevAF?.scan(),
  });

  let filled = 0, failed = 0, total = 0, aiMs = 0;
  const details = [];
  for (const f of frames) {
    const fields = f.result?.fields || [];
    if (!fields.length) continue;
    total += fields.length;
    const { plan, ai: stats } = await planProfile({ fields, profile, ai });
    aiMs += stats.ms;
    if (!plan.length) continue;
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [f.frameId] },
      func: (a) => window.__jevAF?.fill(a),
      args: [plan.map((p) => ({ id: p.id, value: p.value }))],
    });
    (res?.result || []).forEach((r, i) => {
      const good = r.status.startsWith('ok');
      good ? filled++ : failed++;
      details.push({ label: plan[i].label, key: plan[i].key, source: plan[i].source, status: r.status });
    });
  }
  const ms = Math.round(performance.now() - t0);
  return {
    ok: filled > 0,
    message: filled
      ? `「${name}」で${filled}欄を入力（${ms}ms${aiMs ? `、うちAI ${aiMs}ms` : ''}）${failed ? `・失敗${failed}` : ''}。送信はご自身で。`
      : `入れられる欄が見つかりませんでした（${total}欄を確認）`,
    details,
  };
}
