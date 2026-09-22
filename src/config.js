// AI の設定（どのAIを使うか・キー・モデル）の保存と読み込み。
// キーは使う人が自分で入れ、その人のChromeの中（chrome.storage.local）だけに置く。拡張機能のコードには入っていない。
import { PROVIDERS } from './ai.js';

export async function getAIConfig() {
  const s = await chrome.storage.local.get(['aiProvider', 'aiKeys', 'aiModels', 'useAI', 'apiKey', 'useJev']);
  const keys = { ...(s.aiKeys || {}) };
  // v0.3 以前は Jev のキーだけを apiKey に保存していた
  if (!keys.jev && s.apiKey) keys.jev = s.apiKey;
  const provider = PROVIDERS[s.aiProvider] ? s.aiProvider : 'jev';
  const models = { ...(s.aiModels || {}) };
  const enabled = s.useAI ?? (s.useJev !== false);
  return {
    enabled, provider, keys, models,
    apiKey: keys[provider] || '',
    model: models[provider] || PROVIDERS[provider].models[0],
  };
}

// 入力処理に渡す形。AI を使わない設定、またはキーが無ければ null
export async function activeAI() {
  const c = await getAIConfig();
  return c.enabled && c.apiKey ? { provider: c.provider, apiKey: c.apiKey, model: c.model } : null;
}

export async function saveAIConfig({ enabled, provider, keys, models }) {
  await chrome.storage.local.set({ useAI: enabled, aiProvider: provider, aiKeys: keys, aiModels: models });
  await chrome.storage.local.remove(['apiKey', 'useJev']);
}
