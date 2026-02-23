const db = require('./database');
const { encrypt, decrypt } = require('../utils/crypto');

const OPS_PROMPT = `你是一个 Linux 服务器运维专家，专门排查 xray 节点问题。
根据提供的诊断信息分析故障原因，给出：
1. 故障原因（简明扼要）
2. 修复命令（可直接在 bash 执行的命令，每行一条）
回复格式必须严格如下：
===原因===
（故障原因）
===命令===
（修复命令，每行一条，不要加注释和解释）`;

function getOpsConfig() {
  const type = db.getSetting('ops_ai_type');
  const endpoint = db.getSetting('ops_ai_endpoint');
  const key = decrypt(db.getSetting('ops_ai_key') || '');
  const model = db.getSetting('ops_ai_model');
  if (!type || !endpoint || !key || !model) return null;
  return { type, endpoint, key, model };
}

function setOpsConfig(cfg) {
  db.setSetting('ops_ai_type', cfg.type || '');
  db.setSetting('ops_ai_endpoint', cfg.endpoint || '');
  db.setSetting('ops_ai_key', cfg.key ? encrypt(cfg.key) : '');
  db.setSetting('ops_ai_model', cfg.model || '');
}

async function analyze(diagInfo) {
  const cfg = getOpsConfig();
  if (!cfg) return null;

  const message = `以下是节点诊断信息，请分析故障原因并给出修复命令：\n\n${diagInfo}`;
  let url, opts;

  if (cfg.type === 'gemini') {
    url = `${cfg.endpoint.replace(/\/$/, '')}/models/${cfg.model}:generateContent?key=${cfg.key}`;
    opts = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: OPS_PROMPT }] },
        contents: [{ parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.3 }
      })
    };
  } else if (cfg.type === 'claude') {
    url = `${cfg.endpoint.replace(/\/$/, '')}/messages`;
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.3, system: OPS_PROMPT, messages: [{ role: 'user', content: message }] })
    };
  } else {
    url = `${cfg.endpoint.replace(/\/$/, '')}/chat/completions`;
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.3, messages: [{ role: 'system', content: OPS_PROMPT }, { role: 'user', content: message }] })
    };
  }

  const res = await fetch(url, opts);
  if (!res.ok) return null;
  const data = await res.json();

  let text;
  if (cfg.type === 'gemini') text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  else if (cfg.type === 'claude') text = data.content?.[0]?.text;
  else text = data.choices?.[0]?.message?.content;
  if (!text) return null;

  const reasonMatch = text.match(/===原因===\s*([\s\S]*?)(?====命令===|$)/);
  const cmdMatch = text.match(/===命令===\s*([\s\S]*?)$/);
  return {
    analysis: reasonMatch ? reasonMatch[1].trim() : text,
    commands: cmdMatch ? cmdMatch[1].trim().split('\n').filter(l => l.trim()) : []
  };
}

module.exports = { getOpsConfig, setOpsConfig, analyze };
