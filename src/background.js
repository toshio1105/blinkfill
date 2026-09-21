import { fillProfile } from './oneclick.js';

// ツールバーのアイコン（または Alt+J）でサイドパネルを開く
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Alt+Shift+P: サイドパネルを開かずに、選択中のプロフィールで個人情報を入力する
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-profile' || !tab?.id || !/^https?:/.test(tab.url || '')) return;
  const r = await fillProfile(tab.id).catch((e) => ({ ok: false, message: e.message }));
  // 結果はバッジで知らせる（入力欄の数、失敗なら ×）
  const text = r.ok ? String(r.details.filter((d) => d.status.startsWith('ok')).length) : '×';
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: r.ok ? '#2f7d5c' : '#b4453a' });
  await chrome.action.setBadgeText({ tabId: tab.id, text });
  await chrome.action.setTitle({ tabId: tab.id, title: r.message });
  setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 8000);
});
