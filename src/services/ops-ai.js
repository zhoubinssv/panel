const db = require('./database');
const { encrypt, decrypt } = require('../utils/crypto');
const { NodeSSH } = require('node-ssh');

const MAX_ROUNDS = 10; // 最大交互轮次，防止死循环
const CMD_TIMEOUT = 15000; // 单条命令超时 15s

const OPS_PROMPT = `你是一个资深 Linux 服务器运维专家，专门排查 xray/VLESS 节点问题。

你可以通过 SSH 在目标服务器上执行任意命令来诊断和修复问题。

## 工作模式
每轮你可以选择两种操作之一：

### 1. 执行命令（诊断或修复）
输出格式：
===EXEC===
命令1
命令2
...
===END===

### 2. 结束诊断
当你已经修复了问题，或者确认无法修复时：
===DONE===
状态：已修复 / 未修复
原因：（简明扼要的故障原因）
过程：（你做了什么）
===END===

## 规则
- 每轮最多 5 条命令
- 先诊断再修复，不要盲目操作
- 常见排查思路：检查 xray 状态 → 查日志 → 查端口 → 查配置 → 查资源 → 查网络
- 修复后要验证（比如重启后检查端口是否监听）
- 如果多轮尝试仍无法修复，诚实说明原因
- 不要执行 reboot、rm -rf /、dd 等危险命令
- 不要修改 SSH 配置或防火墙规则（除非确认是防火墙问题）`;

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

// 危险命令黑名单
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/,  // rm -rf /
  /\breboot\b/,
  /\bshutdown\b/,
  /\binit\s+0\b/,
  /\bdd\s+.*of=\/dev\/[sh]d/,
  /\bmkfs\b/,
  />\s*\/dev\/[sh]d/,
  /\bpasswd\b/,
  /\buserdel\b/,
];

function isSafeCommand(cmd) {
  return !DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

// 调用 AI API（统一封装）
async function callAI(cfg, messages) {
  let url, opts;

  if (cfg.type === 'gemini') {
    url = `${cfg.endpoint.replace(/\/$/, '')}/models/${cfg.model}:generateContent?key=${cfg.key}`;
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    opts = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: messages.find(m => m.role === 'system')?.content || OPS_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 2048, temperature: 0.3 }
      })
    };
  } else if (cfg.type === 'claude') {
    url = `${cfg.endpoint.replace(/\/$/, '')}/messages`;
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 2048, temperature: 0.3,
        system: messages.find(m => m.role === 'system')?.content || OPS_PROMPT,
        messages: messages.filter(m => m.role !== 'system')
      })
    };
  } else {
    url = `${cfg.endpoint.replace(/\/$/, '')}/chat/completions`;
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.3, messages })
    };
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[OPS-AI] API 调用失败 (${res.status}):`, errText.substring(0, 200));
    return null;
  }
  const data = await res.json();

  if (cfg.type === 'gemini') return data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (cfg.type === 'claude') return data.content?.[0]?.text;
  return data.choices?.[0]?.message?.content;
}

// 通过 SSH 执行命令
async function execSSH(ssh, cmd, timeout = CMD_TIMEOUT) {
  try {
    const result = await ssh.execCommand(cmd, { execOptions: { timeout } });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return output || '(无输出)';
  } catch (e) {
    return `(执行失败: ${e.message})`;
  }
}

// 解析 AI 回复
function parseAIResponse(text) {
  // 检查是否是 DONE
  const doneMatch = text.match(/===DONE===([\s\S]*?)===END===/);
  if (doneMatch) {
    const body = doneMatch[1];
    const status = body.match(/状态[：:]\s*(.+)/)?.[1]?.trim() || '未知';
    const reason = body.match(/原因[：:]\s*([\s\S]*?)(?=过程[：:]|$)/)?.[1]?.trim() || '';
    const process = body.match(/过程[：:]\s*([\s\S]*?)$/)?.[1]?.trim() || '';
    return { type: 'done', status, reason, process };
  }

  // 检查是否有命令要执行
  const execMatch = text.match(/===EXEC===([\s\S]*?)===END===/);
  if (execMatch) {
    const commands = execMatch[1].trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return { type: 'exec', commands: commands.slice(0, 5) }; // 最多 5 条
  }

  // 无法解析，当作分析文本
  return { type: 'unknown', text };
}

/**
 * 多轮交互式 AI 诊断
 * @param {Object} node - 节点信息（已解密）
 * @param {Function} onProgress - 进度回调 (round, log)
 * @returns {Object} { success, analysis, log }
 */
async function interactiveDiagnose(node, onProgress) {
  const cfg = getOpsConfig();
  if (!cfg) return { success: false, analysis: '运维 AI 未配置', log: '' };

  const ssh = new NodeSSH();
  const connectOpts = {
    host: node.ssh_host || node.host,
    port: node.ssh_port || 22,
    username: node.ssh_user || 'root',
    readyTimeout: 10000
  };
  if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
  else connectOpts.password = node.ssh_password;

  const fullLog = [];
  const log = (msg) => { fullLog.push(msg); };

  try {
    log(`🔌 SSH 连接 ${node.ssh_host || node.host}:${node.ssh_port || 22}...`);
    await ssh.connect(connectOpts);
    log('✅ SSH 连接成功\n');

    // 构建初始上下文
    const nodeInfo = [
      `节点名称: ${node.name}`,
      `节点 IP: ${node.host}`,
      `xray 端口: ${node.port}`,
      `协议: VLESS + Reality (XTLS Vision)`,
      `xray 配置路径: ${node.xray_config_path || '/usr/local/etc/xray/config.json'}`,
      node.socks5_host ? `Socks5 落地: ${node.socks5_host}:${node.socks5_port}` : null,
      node.region ? `地区: ${node.region}` : null,
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: OPS_PROMPT },
      { role: 'user', content: `节点出现异常，请诊断并修复。\n\n## 节点信息\n${nodeInfo}\n\n请开始诊断。` }
    ];

    let fixed = false;
    let finalAnalysis = '';

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      log(`\n${'='.repeat(40)}`);
      log(`🤖 第 ${round}/${MAX_ROUNDS} 轮 AI 分析中...`);

      const aiText = await callAI(cfg, messages);
      if (!aiText) {
        log('❌ AI API 调用失败');
        finalAnalysis = `AI (${cfg.model}) 调用失败`;
        break;
      }

      log(`\n💬 AI 回复:\n${aiText}\n`);
      messages.push({ role: 'assistant', content: aiText });

      const parsed = parseAIResponse(aiText);

      if (parsed.type === 'done') {
        fixed = parsed.status.includes('已修复');
        finalAnalysis = `${parsed.status}\n\n原因: ${parsed.reason}\n\n过程: ${parsed.process}`;
        log(`\n🏁 AI 诊断结束: ${parsed.status}`);
        break;
      }

      if (parsed.type === 'exec') {
        const results = [];
        for (const cmd of parsed.commands) {
          if (!isSafeCommand(cmd)) {
            const msg = `⛔ 危险命令已拦截: ${cmd}`;
            log(msg);
            results.push(`$ ${cmd}\n${msg}`);
            continue;
          }
          log(`$ ${cmd}`);
          const output = await execSSH(ssh, cmd);
          log(output);
          results.push(`$ ${cmd}\n${output}`);
        }

        // 把执行结果喂回 AI
        messages.push({ role: 'user', content: `命令执行结果:\n\n${results.join('\n\n')}` });
      } else {
        // AI 回复格式不对，提醒它
        messages.push({ role: 'user', content: '请按照规定格式回复：用 ===EXEC=== 包裹要执行的命令，或用 ===DONE=== 结束诊断。' });
      }

      if (onProgress) onProgress(round, fullLog.join('\n'));
    }

    if (!finalAnalysis) {
      finalAnalysis = `达到最大轮次 (${MAX_ROUNDS})，AI 未能完成诊断`;
    }

    return {
      success: fixed,
      analysis: `🤖 模型: ${cfg.type.toUpperCase()} / ${cfg.model}\n\n${finalAnalysis}`,
      log: fullLog.join('\n')
    };

  } catch (e) {
    log(`\n❌ 错误: ${e.message}`);
    return {
      success: false,
      analysis: `SSH 连接失败: ${e.message}`,
      log: fullLog.join('\n')
    };
  } finally {
    ssh.dispose();
  }
}

// 兼容旧接口（单轮分析）
async function analyze(diagInfo) {
  const cfg = getOpsConfig();
  if (!cfg) return null;

  const messages = [
    { role: 'system', content: OPS_PROMPT },
    { role: 'user', content: `以下是节点诊断信息，请分析故障原因并给出修复命令：\n\n${diagInfo}` }
  ];

  const text = await callAI(cfg, messages);
  if (!text) return null;

  const reasonMatch = text.match(/===原因===\s*([\s\S]*?)(?====命令===|$)/);
  const cmdMatch = text.match(/===命令===\s*([\s\S]*?)$/);
  return {
    analysis: reasonMatch ? reasonMatch[1].trim() : text,
    commands: cmdMatch ? cmdMatch[1].trim().split('\n').filter(l => l.trim()) : []
  };
}

module.exports = { getOpsConfig, setOpsConfig, analyze, interactiveDiagnose, callAI };
