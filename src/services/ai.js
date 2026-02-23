const db = require('./database');

// 系统提示词 - 通用助手模式
const DEFAULT_PROMPT = 'You are a helpful assistant. 请用中文回答。';

// ========== 获取管理员指定的 AI 服务商 ==========

function getActiveProvider() {
  const activeId = db.getSetting('active_ai_provider');
  if (!activeId) return null;
  const provider = db.getAiProviderById(parseInt(activeId));
  if (!provider || !provider.enabled) return null;
  return provider;
}

// ========== 统一调用接口（非流式） ==========

async function chat(message) {
  const provider = getActiveProvider();
  if (!provider) return '未指定 AI 服务，请管理员在后台选择。';

  try {
    const result = await callProvider(provider, message);
    if (result) return result;
  } catch (err) {
    console.error(`[AI] ${provider.name} 调用失败:`, err.message);
  }
  return 'AI 服务调用失败，请检查配置。';
}

// ========== 流式调用（SSE） ==========

async function chatStream(message, history, onChunk, onDone, onError, providerId) {
  let provider;
  if (providerId) {
    provider = db.getAiProviderById(providerId);
    if (!provider || !provider.enabled) {
      onError('所选模型不可用。');
      return;
    }
  } else {
    provider = getActiveProvider();
  }
  if (!provider) {
    onError('未选择 AI 模型，请先选择一个。');
    return;
  }

  // 构建消息列表
  const sysPrompt = provider.system_prompt || DEFAULT_PROMPT;
  const messages = [{ role: 'system', content: sysPrompt }];
  if (history && history.length > 0) {
    const recent = history.slice(-10);
    for (const msg of recent) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    await callProviderStream(provider, messages, onChunk, onDone);
  } catch (err) {
    console.error(`[AI Stream] ${provider.name} 失败:`, err.message);
    onError(`AI 服务调用失败: ${err.message}`);
  }
}

// ========== 各协议调用（非流式） ==========

async function callProvider(provider, message) {
  switch (provider.type) {
    case 'openai': return await callOpenAI(provider, message);
    case 'gemini': return await callGemini(provider, message);
    case 'claude': return await callClaude(provider, message);
    default: return null;
  }
}

async function callOpenAI(provider, message) {
  const url = `${provider.endpoint.replace(/\/$/, '')}/chat/completions`;
  const sysPrompt = provider.system_prompt || DEFAULT_PROMPT;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`
    },
    body: JSON.stringify({
      model: provider.model_id,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 2048,
      temperature: 0.7
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callGemini(provider, message) {
  const url = `${provider.endpoint.replace(/\/$/, '')}/models/${provider.model_id}:generateContent?key=${provider.api_key}`;
  const sysPrompt = provider.system_prompt || DEFAULT_PROMPT;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sysPrompt }] },
      contents: [{ parts: [{ text: message }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callClaude(provider, message) {
  const url = `${provider.endpoint.replace(/\/$/, '')}/messages`;
  const isOfficial = provider.endpoint.includes('anthropic.com');
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  };
  if (isOfficial) {
    headers['x-api-key'] = provider.api_key;
  } else {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model_id,
      max_tokens: 2048,
      system: provider.system_prompt || DEFAULT_PROMPT,
      messages: [{ role: 'user', content: message }]
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.content?.[0]?.text || null;
}

// ========== 流式调用 ==========

async function callProviderStream(provider, messages, onChunk, onDone) {
  switch (provider.type) {
    case 'openai': return await streamOpenAI(provider, messages, onChunk, onDone);
    case 'gemini': return await streamGemini(provider, messages, onChunk, onDone);
    case 'claude': return await streamClaude(provider, messages, onChunk, onDone);
    default: throw new Error('未知的 AI 协议类型');
  }
}

async function streamOpenAI(provider, messages, onChunk, onDone) {
  const url = `${provider.endpoint.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`
    },
    body: JSON.stringify({
      model: provider.model_id,
      messages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: true
    })
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);

  let doneCalled = false;
  await parseSSEStream(res.body, (data) => {
    if (doneCalled) return;
    if (data === '[DONE]') { doneCalled = true; onDone(); return; }
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onChunk(delta);
      if (json.choices?.[0]?.finish_reason && !doneCalled) {
        doneCalled = true;
        onDone();
      }
    } catch {}
  });
  if (!doneCalled) onDone();
}

async function streamGemini(provider, messages, onChunk, onDone) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const contents = chatMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const url = `${provider.endpoint.replace(/\/$/, '')}/models/${provider.model_id}:streamGenerateContent?alt=sse&key=${provider.api_key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
    })
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  let doneCalled = false;
  await parseSSEStream(res.body, (data) => {
    if (doneCalled) return;
    try {
      const json = JSON.parse(data);
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) onChunk(text);
      if (json.candidates?.[0]?.finishReason && !doneCalled) {
        doneCalled = true;
        onDone();
      }
    } catch {}
  });
  if (!doneCalled) onDone();
}

async function streamClaude(provider, messages, onChunk, onDone) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');

  const url = `${provider.endpoint.replace(/\/$/, '')}/messages`;
  const isOfficial = provider.endpoint.includes('anthropic.com');
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  };
  if (isOfficial) {
    headers['x-api-key'] = provider.api_key;
  } else {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model_id,
      max_tokens: 2048,
      system: systemMsg?.content || DEFAULT_PROMPT,
      messages: chatMsgs,
      stream: true
    })
  });

  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);

  let doneCalled = false;
  await parseSSEStream(res.body, (data) => {
    if (doneCalled) return;
    try {
      const json = JSON.parse(data);
      // 只处理 content_block_delta 和 message_stop，忽略其他事件
      if (json.type === 'content_block_delta') {
        const text = json.delta?.text;
        if (text) onChunk(text);
      }
      if (json.type === 'message_stop' && !doneCalled) {
        doneCalled = true;
        onDone();
      }
    } catch {}
  });
  if (!doneCalled) onDone();
}

// ========== SSE 流解析器 ==========

async function parseSSEStream(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        // Claude 的 SSE 有 event: 行，只取 data: 行
        if (trimmed.startsWith('data: ')) {
          onData(trimmed.slice(6));
        }
      }
    }
    if (buffer.trim().startsWith('data: ')) {
      onData(buffer.trim().slice(6));
    }
  } finally {
    reader.releaseLock();
  }
}

module.exports = { chat, chatStream, getActiveProvider };
