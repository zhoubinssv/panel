const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { randomPort } = require('../utils/vless');
const deployService = require('../services/deploy');
const aiService = require('../services/ai');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ========== 白名单 API ==========

router.post('/whitelist/add', (req, res) => {
  const { username } = req.body;
  const user = username && db.getAllUsers().find(u => u.username === username.trim());
  if (user) {
    db.addToWhitelist(user.nodeloc_id);
    db.addAuditLog(req.user.id, 'whitelist_add', `添加白名单: ${user.username}`, req.ip);
    const { syncAllNodesConfig } = require('../services/deploy');
    syncAllNodesConfig(db).catch(() => {});
  }
  res.redirect('/admin#whitelist');
});

router.post('/whitelist/remove', (req, res) => {
  const { nodeloc_id } = req.body;
  if (nodeloc_id) {
    db.removeFromWhitelist(parseInt(nodeloc_id));
    db.addAuditLog(req.user.id, 'whitelist_remove', `移除白名单: ID#${nodeloc_id}`, req.ip);
    const { syncAllNodesConfig } = require('../services/deploy');
    syncAllNodesConfig(db).catch(() => {});
  }
  res.redirect('/admin#whitelist');
});

// ========== 节点 API ==========

// ========== 部署节点（SSH 自动安装 xray）==========

router.post('/nodes/deploy', (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');

  // 检查 IP 是否已存在
  const existing = db.getAllNodes().find(n => n.host === host.trim());
  if (existing) {
    db.addAuditLog(req.user.id, 'node_deploy_dup', `重复 IP: ${host} (已有节点: ${existing.name})`, req.ip);
    return res.redirect('/admin?msg=dup#nodes');
  }

  db.addAuditLog(req.user.id, 'node_deploy_start', `开始部署: ${host}${socks5_host ? ' (socks5→' + socks5_host + ')' : ''}`, req.ip);

  deployService.deployNode({
    host,
    ssh_port: parseInt(ssh_port) || 22,
    ssh_user: ssh_user || 'root',
    ssh_password,
    socks5_host: socks5_host || null,
    socks5_port: parseInt(socks5_port) || 1080,
    socks5_user: socks5_user || null,
    socks5_pass: socks5_pass || null,
    triggered_by: req.user.id
  }, db).catch(err => {
    console.error('[部署异常]', err);
  });

  res.redirect('/admin?msg=deploying#nodes');
});

// ========== 手动添加节点（家宽/已部署）==========

router.post('/nodes/manual', async (req, res) => {
  const { host, port, uuid, name, remark } = req.body;
  if (!host || !port || !uuid) return res.redirect('/admin#nodes');

  const deployService = require('../services/deploy');
  const geo = await deployService.detectRegion(host);
  const existingNodes = db.getAllNodes();
  const nodeName = name?.trim() || deployService.generateNodeName(geo, existingNodes);
  const region = `${geo.emoji} ${geo.cityCN}`;

  db.addNode({
    name: nodeName, host,
    port: parseInt(port), uuid,
    region,
    remark: remark || '🏠 家宽/手动',
    is_active: 1
  });
  db.addAuditLog(req.user.id, 'node_manual_add', `手动添加: ${nodeName} (${host}:${port})`, req.ip);
  res.redirect('/admin?msg=added#nodes');
});

// ========== 手动添加已有节点 ==========

router.post('/nodes/add', (req, res) => {
  const { name, host, port, region, ssh_host, ssh_user, ssh_password, ssh_key_path, remark } = req.body;
  if (!name || !host || !port) return res.redirect('/admin#nodes');

  db.addNode({
    name, host,
    port: parseInt(port),
    uuid: uuidv4(),
    ssh_host: ssh_host || host,
    ssh_user: ssh_user || 'root',
    ssh_password,
    ssh_key_path,
    region, remark
  });
  db.addAuditLog(req.user.id, 'node_add', `添加节点: ${name} (${host})`, req.ip);
  res.redirect('/admin?msg=added#nodes');
});

router.post('/nodes/:id/delete', (req, res) => {
  const node = db.getNodeById(req.params.id);
  if (node) {
    db.deleteNode(req.params.id);
    db.addAuditLog(req.user.id, 'node_delete', `删除节点: ${node.name}`, req.ip);
  }
  res.redirect('/admin#nodes');
});

router.post('/nodes/:id/update-host', (req, res) => {
  const { host } = req.body;
  const node = db.getNodeById(req.params.id);
  if (node && host?.trim()) {
    const oldHost = node.host;
    db.updateNode(node.id, { host: host.trim(), ssh_host: host.trim() });
    db.addAuditLog(req.user.id, 'node_update_ip', `${node.name} IP变更: ${oldHost} → ${host.trim()}`, req.ip);
  }
  res.redirect('/admin#nodes');
});

router.post('/nodes/:id/update-level', async (req, res) => {
  const node = db.getNodeById(req.params.id);
  const level = parseInt(req.body.level) || 0;
  if (node) {
    db.updateNode(node.id, { min_level: Math.max(0, Math.min(4, level)) });
    db.addAuditLog(req.user.id, 'node_update_level', `${node.name} 等级: Lv.${level}`, req.ip);
    const { syncNodeConfig } = require('../services/deploy');
    syncNodeConfig(node, db).catch(() => {});
  }
  res.json({ ok: true });
});

// ========== 用户 API ==========

router.post('/users/:id/toggle-block', async (req, res) => {
  const user = db.getUserById(req.params.id);
  if (user) {
    db.blockUser(user.id, !user.is_blocked);
    db.addAuditLog(req.user.id, 'user_block', `${user.is_blocked ? '解封' : '封禁'} 用户: ${user.username}`, req.ip);
    // 封禁/解封后异步同步所有节点配置
    const { syncAllNodesConfig } = require('../services/deploy');
    syncAllNodesConfig(db).catch(() => {});
  }
  res.redirect('/admin#users');
});

router.post('/users/:id/reset-token', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (user) {
    db.resetSubToken(user.id);
    db.addAuditLog(req.user.id, 'token_reset', `重置订阅: ${user.username}`, req.ip);
  }
  res.redirect('/admin#users');
});

// ========== 手动健康检测 ==========

router.post('/health-check', async (req, res) => {
  const healthService = require('../services/health');
  try {
    await healthService.checkAllNodes();
    db.addAuditLog(req.user.id, 'health_check', '手动健康检测', req.ip);
  } catch (err) {
    console.error('[健康检测]', err);
  }
  res.redirect('/admin#nodes');
});

// ========== 手动轮换 ==========

router.post('/rotate', (req, res) => {
  const rotateService = require('../services/rotate');
  db.addAuditLog(req.user.id, 'manual_rotate', '手动轮换（后台执行中）', req.ip);
  res.redirect('/admin#nodes');
  rotateService.rotateManual().catch(err => console.error('[手动轮换] 失败:', err));
});

// ========== AI 服务商配置 ==========

router.get('/ai/providers', (req, res) => {
  const providers = db.getAllAiProviders();
  // 隐藏 key 中间部分
  const safe = providers.map(p => ({
    ...p,
    api_key_masked: p.api_key.substring(0, 6) + '***' + p.api_key.slice(-4)
  }));
  res.json(safe);
});

router.post('/ai/providers', (req, res) => {
  const { type, name, endpoint, api_key, model_id, model_name, enabled, priority, system_prompt } = req.body;
  if (!type || !name || !endpoint || !api_key || !model_id) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  // 默认端点
  const defaults = {
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    claude: 'https://api.anthropic.com/v1'
  };
  const result = db.addAiProvider({
    type, name,
    endpoint: endpoint.trim() || defaults[type] || '',
    api_key: api_key.trim(),
    model_id: model_id.trim(),
    model_name: (model_name || '').trim(),
    enabled: enabled !== false,
    priority: parseInt(priority) || 0,
    system_prompt: (system_prompt || '').trim()
  });
  db.addAuditLog(req.user.id, 'ai_provider_add', `添加 AI 服务: ${name} (${type})`, req.ip);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/ai/providers/:id', (req, res) => {
  const provider = db.getAiProviderById(req.params.id);
  if (!provider) return res.status(404).json({ error: '不存在' });

  const fields = {};
  const allowed = ['type', 'name', 'endpoint', 'api_key', 'model_id', 'model_name', 'enabled', 'priority', 'system_prompt'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields[key] = key === 'enabled' ? (req.body[key] ? 1 : 0) : req.body[key];
    }
  }
  if (Object.keys(fields).length > 0) {
    db.updateAiProvider(provider.id, fields);
    db.addAuditLog(req.user.id, 'ai_provider_update', `更新 AI 服务: ${provider.name}`, req.ip);
  }
  res.json({ ok: true });
});

router.delete('/ai/providers/:id', (req, res) => {
  const provider = db.getAiProviderById(req.params.id);
  if (!provider) return res.status(404).json({ error: '不存在' });
  db.deleteAiProvider(provider.id);
  db.addAuditLog(req.user.id, 'ai_provider_delete', `删除 AI 服务: ${provider.name}`, req.ip);
  res.json({ ok: true });
});

router.post('/ai/providers/:id/toggle', (req, res) => {
  const provider = db.getAiProviderById(req.params.id);
  if (!provider) return res.status(404).json({ error: '不存在' });
  db.updateAiProvider(provider.id, { enabled: provider.enabled ? 0 : 1 });
  // 如果禁用的是当前激活的，清除激活状态
  const activeId = db.getSetting('active_ai_provider');
  if (provider.enabled && activeId === String(provider.id)) {
    db.setSetting('active_ai_provider', '');
  }
  db.addAuditLog(req.user.id, 'ai_provider_toggle', `${provider.enabled ? '禁用' : '启用'} AI 服务: ${provider.name}`, req.ip);
  res.json({ ok: true, enabled: !provider.enabled });
});

// 设为当前使用的 AI 服务
router.post('/ai/providers/:id/activate', (req, res) => {
  const provider = db.getAiProviderById(req.params.id);
  if (!provider) return res.status(404).json({ error: '不存在' });
  if (!provider.enabled) return res.status(400).json({ error: '请先启用该服务' });
  db.setSetting('active_ai_provider', String(provider.id));
  db.addAuditLog(req.user.id, 'ai_provider_activate', `指定 AI 服务: ${provider.name}`, req.ip);
  res.json({ ok: true });
});

// 获取当前激活的 AI 服务
router.get('/ai/active', (req, res) => {
  const activeId = db.getSetting('active_ai_provider');
  res.json({ activeId: activeId ? parseInt(activeId) : null });
});

// TG 通知配置
router.post('/notify/config', (req, res) => {
  const { token, chatId } = req.body;
  if (token) db.setSetting('tg_bot_token', token);
  if (chatId !== undefined) db.setSetting('tg_chat_id', chatId || '');
  res.json({ ok: true });
});

router.post('/notify/test', async (req, res) => {
  const { send } = require('../services/notify');
  try {
    await send('🔔 测试通知 - 小姨子的诱惑面板通知已配置成功！');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/notify/event', (req, res) => {
  const { key, enabled } = req.body;
  if (!key || !key.startsWith('tg_on_')) return res.status(400).json({ error: '无效' });
  db.setSetting(key, enabled ? 'true' : 'false');
  res.json({ ok: true });
});

// 流量排行分页
router.get('/traffic', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const { rows, total } = db.getAllUsersTraffic(date, limit, (page - 1) * limit);
  res.json({ rows, total, page, pages: Math.ceil(total / limit), date });
});

// 日志分页
router.get('/logs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const { rows, total } = db.getAuditLogs(limit, (page - 1) * limit);
  res.json({ rows, total, page, pages: Math.ceil(total / limit) });
});

router.post('/logs/clear', (req, res) => {
  db.clearAuditLogs();
  db.addAuditLog(req.user.id, 'logs_clear', '清空审计日志', req.ip);
  res.json({ ok: true });
});

// 公告
router.post('/announcement', (req, res) => {
  db.setSetting('announcement', (req.body.text || '').trim());
  db.addAuditLog(req.user.id, 'announcement', '更新公告', req.ip);
  res.json({ ok: true });
});

// 运维诊断
router.get('/ops/list', (req, res) => {
  res.json(db.getAllDiagnoses(30));
});

router.post('/ops/:id/diagnose', async (req, res) => {
  const node = db.getNodeById(req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const { autoRepair } = require('../services/health');
  autoRepair(node).catch(e => console.error('[手动诊断]', e.message));
  db.addAuditLog(req.user.id, 'ops_diagnose', `手动诊断: ${node.name}`, req.ip);
  res.json({ ok: true });
});

router.post('/ops/:id/execute', async (req, res) => {
  const diag = db.getDiagnosis(req.params.id);
  if (!diag || diag.status === 'fixed') return res.status(400).json({ error: '无效或已修复' });

  const commands = JSON.parse(diag.fix_commands || '[]');
  if (commands.length === 0) return res.status(400).json({ error: '无修复命令' });

  const node = db.getNodeById(diag.node_id);
  if (!node || (!node.ssh_password && !node.ssh_key_path)) return res.status(400).json({ error: '节点无 SSH 信息' });

  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  const connectOpts = {
    host: node.ssh_host || node.host, port: node.ssh_port || 22,
    username: node.ssh_user || 'root', readyTimeout: 10000
  };
  if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
  else connectOpts.password = node.ssh_password;

  try {
    await ssh.connect(connectOpts);
    const results = [];
    for (const cmd of commands) {
      const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30000 } });
      results.push(`$ ${cmd}\n${r.stdout || r.stderr || '(ok)'}`);
    }
    ssh.dispose();

    const fixResult = results.join('\n\n');
    db.updateDiagnosis(diag.id, { status: 'fixed', fix_result: fixResult, resolved_at: new Date().toISOString() });
    db.addAuditLog(req.user.id, 'ops_fix', `执行修复: ${node.name} (诊断#${diag.id})`, req.ip);

    const { notify } = require('../services/notify');
    notify.send(`✅ 节点 ${node.name} 修复命令已执行\n\n${fixResult.substring(0, 500)}`).catch(() => {});

    res.json({ ok: true, result: fixResult });
  } catch (e) {
    ssh.dispose();
    res.status(500).json({ error: 'SSH 执行失败: ' + e.message });
  }
});

router.post('/ops/:id/dismiss', (req, res) => {
  db.updateDiagnosis(req.params.id, { status: 'dismissed', resolved_at: new Date().toISOString() });
  res.json({ ok: true });
});

router.post('/ops/clear', (req, res) => {
  db.clearDiagnoses();
  res.json({ ok: true });
});

router.post('/ops/ai-config', (req, res) => {
  const { type, endpoint, key, model } = req.body;
  const opsAi = require('../services/ops-ai');
  const current = opsAi.getOpsConfig();
  opsAi.setOpsConfig({ type: type || '', endpoint: endpoint || '', key: key || (current?.key) || '', model: model || '' });
  res.json({ ok: true });
});

router.get('/ops/ai-config', (req, res) => {
  const opsAi = require('../services/ops-ai');
  const cfg = opsAi.getOpsConfig();
  res.json({ type: cfg?.type || '', endpoint: cfg?.endpoint || '', model: cfg?.model || '', configured: !!cfg });
});

// 订阅滥用检测
router.get('/sub-abuse', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const minIPs = parseInt(req.query.min) || 3;
  const abusers = db.getSubAbuseUsers(hours, minIPs);
  // 补充用户名
  const result = abusers.map(a => {
    const user = db.getUserById(a.user_id);
    return { ...a, username: user?.username || '未知' };
  });
  res.json(result);
});

// 查看某用户的订阅拉取 IP
router.get('/sub-access/:userId', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(db.getSubAccessIPs(parseInt(req.params.userId), hours));
});

module.exports = router;
