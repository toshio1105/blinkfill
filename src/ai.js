// 「どの欄に何を入れるか」を AI に選ばせる部分。Jev と LLM（OpenAI / Claude / Gemini）を同じ形で呼ぶ。
//
// 入力: state（貼り付けた内容など。個人情報の値は入れない）と questions（欄ごとの選択式の質問）
// 出力: { answers: { 質問ID: { choice, confidence } }, ms, requests }
//
// Jev は選択に特化したモデルで、選択肢ごとの確信度も返す。
// LLM は確信度を返さないので、答えが返った欄は一律 LLM_CONFIDENCE とみなす。
import { Anthropic } from '../vendor/anthropic.js';

export const LLM_CONFIDENCE = 0.8;

export const PROVIDERS = {
  jev: {
    label: 'Jev（TypeSafe）', badge: 'おすすめ・最速',
    note: '選択に特化したAI。自社計測で他のAIより3〜7倍速く、費用は1/14〜1/29。現在は招待制',
    keyUrl: 'https://console.typesafe.ai/', keyHint: 'apikey_...',
    models: ['jev-latest'],
  },
  openai: {
    label: 'OpenAI', note: 'GPT系。高速・低価格の Luna が向いています',
    keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-...',
    models: ['gpt-5.6-luna'],
  },
  anthropic: {
    label: 'Claude（Anthropic）', note: 'Haiku 4.5 は速く安い。Opus 5 は最も賢いが遅め',
    keyUrl: 'https://console.anthropic.com/', keyHint: 'sk-ant-...',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
  gemini: {
    label: 'Gemini（Google）', note: '無料枠あり',
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza...',
    models: ['gemini-3.8-flash'],
  },
};

const JEV_BATCH = 12;

export async function askChoices({ provider = 'jev', apiKey, model, state, questions, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('APIキーが未設定です（設定から登録してください）');
  const ids = Object.keys(questions);
  if (!ids.length) return { answers: {}, ms: 0, requests: 0 };
  const t0 = performance.now();

  if (provider === 'jev') {
    // 選択欄とその根拠の質問（xxx__src）は同じリクエストに入れる
    const chunks = [];
    let cur = [];
    for (const id of ids) {
      cur.push(id);
      if (cur.length >= JEV_BATCH && !questions[`${id}__src`]) { chunks.push(cur); cur = []; }
    }
    if (cur.length) chunks.push(cur);
    const results = await Promise.all(chunks.map(async (chunk) => {
      const res = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'jev-latest', state,
          questions: Object.fromEntries(chunk.map((id) => [id, questions[id]])),
        }),
      });
      await raiseFor(res, 'Jev');
      return (await res.json()).answers ?? {};
    }));
    const answers = {};
    for (const r of results) for (const [id, a] of Object.entries(r)) answers[id] = { choice: a?.choice, confidence: a?.confidence ?? 0 };
    return { answers, ms: Math.round(performance.now() - t0), requests: chunks.length };
  }

  // --- LLM: 全部の質問を1回で聞き、{質問ID: 選択肢キー} の JSON で返させる ---
  const { system, user } = llmPrompt(state, questions);
  let text;
  if (provider === 'openai') text = await callOpenAI({ apiKey, model, system, user, fetchImpl });
  else if (provider === 'anthropic') text = await callClaude({ apiKey, model, system, user });
  else if (provider === 'gemini') text = await callGemini({ apiKey, model, system, user, fetchImpl });
  else throw new Error(`未対応のAI: ${provider}`);

  const parsed = parseJson(text);
  const answers = {};
  for (const id of ids) {
    const key = parsed?.[id];
    const valid = typeof key === 'string' && (key === 'none' || key in questions[id].criteria);
    answers[id] = { choice: valid ? key : 'none', confidence: valid && key !== 'none' ? LLM_CONFIDENCE : 0 };
  }
  return { answers, ms: Math.round(performance.now() - t0), requests: 1 };
}

function llmPrompt(state, questions) {
  const system = [
    'あなたはWebフォームの入力を補助する。各質問について、示された選択肢のキーから1つだけ選ぶ。',
    '当てはまるものが無い、または判断できない質問は "none" を選ぶ。推測で埋めない。',
    '出力は JSON オブジェクトだけにする。形式: {"質問ID": "選択肢キー", ...}。説明文やコードブロックは付けない。',
  ].join('\n');
  const body = Object.entries(questions).map(([id, q]) => {
    const opts = Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    return `### ${id}\n${q.instructions}\n選択肢:\n${opts}`;
  }).join('\n\n');
  return { system, user: `${state}\n\n質問:\n\n${body}` };
}

function parseJson(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AIの回答を読み取れませんでした');
  try { return JSON.parse(m[0]); } catch { throw new Error('AIの回答がJSONになっていませんでした'); }
}

async function raiseFor(res, name) {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) throw new Error(`${name}のAPIキーが無効です`);
  if (res.status === 429 || res.status === 529) throw new Error(`${name}が混雑しています。少し待って再実行してください`);
  throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function callOpenAI({ apiKey, model, system, user, fetchImpl }) {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'gpt-5.6-luna',
      max_completion_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  await raiseFor(res, 'OpenAI');
  return (await res.json()).choices?.[0]?.message?.content;
}

async function callGemini({ apiKey, model, system, user, fetchImpl }) {
  const m = model || 'gemini-3.8-flash';
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  await raiseFor(res, 'Gemini');
  return (await res.json()).candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
}

// Claude は公式SDK（vendor/anthropic.js に同梱）で呼ぶ。
// 使う人が自分のキーを入れ、そのPCの中だけに保存する作りなので dangerouslyAllowBrowser を有効にする。
async function callClaude({ apiKey, model, system, user }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const m = model || 'claude-opus-5';
  const base = { model: m, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] };
  let msg;
  try {
    if (m === 'claude-opus-5') {
      // 判断が単純なので effort は low。安全判定で断られた場合はサーバー側で別モデルに切り替える
      msg = await client.beta.messages.create({
        ...base, output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
    } else if (m === 'claude-sonnet-5') {
      msg = await client.messages.create({ ...base, output_config: { effort: 'low' } });
    } else {
      msg = await client.messages.create(base);
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('ClaudeのAPIキーが無効です');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claudeが混雑しています。少し待って再実行してください');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude ${e.status ?? ''}: ${String(e.message).slice(0, 200)}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claudeがこの依頼への回答を控えました');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
