const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { randomPort } = require('../utils/vless');
const deployService = require('../services/deploy');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ========== 参数校验工具 ==========

// 校验 req.params 中的 id 为正整数，返回数值或 null
function parseIntId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 校验 host 为合法 IP 或域名（禁止命令注入字符）
const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;
function isValidHost(host) {
  return typeof host === 'string' && HOST_RE.test(host.trim());
}

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

// ========== 注册白名单 ==========
router.post('/register-whitelist/add', (req, res) => {
  const username = (req.body.username || '').trim();
  if (username) {
    db.addToRegisterWhitelist(username);
    db.addAuditLog(req.user.id, 'reg_whitelist_add', `添加注册白名单: ${username}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

router.post('/register-whitelist/remove', (req, res) => {
  const username = (req.body.username || '').trim();
  if (username) {
    db.removeFromRegisterWhitelist(username);
    db.addAuditLog(req.user.id, 'reg_whitelist_remove', `移除注册白名单: ${username}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

// ========== 节点 API ==========

// ========== 部署节点（SSH 自动安装 xray）==========

router.post('/nodes/deploy', (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');
  if (!isValidHost(host)) return res.redirect('/admin?msg=invalid_host#nodes');

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


router.post('/nodes/:id/delete', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.redirect('/admin#nodes');

  const agentWs = require('../services/agent-ws');
  const stopCmd = 'systemctl stop xray && systemctl disable xray && systemctl stop vless-agent && systemctl disable vless-agent';

  // 异步停掉远端服务，不阻塞页面跳转
  (async () => {
    try {
      if (agentWs.isAgentOnline(node.id)) {
        await agentWs.sendCommand(node.id, { type: 'exec', command: stopCmd });
      } else if (node.ssh_password || node.ssh_key_path) {
        const { NodeSSH } = require('node-ssh');
        const ssh = new NodeSSH();
        const connectOpts = {
          host: node.ssh_host || node.host, port: node.ssh_port || 22,
          username: node.ssh_user || 'root', readyTimeout: 10000
        };
        if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
        else connectOpts.password = node.ssh_password;
        await ssh.connect(connectOpts);
        await ssh.execCommand(stopCmd, { execOptions: { timeout: 15000 } });
        ssh.dispose();
      }
    } catch (err) {
      console.error(`[删除节点] 停止远端服务失败: ${err.message}`);
    }
    db.deleteNode(node.id);
    db.addAuditLog(req.user.id, 'node_delete', `删除节点: ${node.name}`, req.ip);
  })();

  res.redirect('/admin#nodes');
});

router.post('/nodes/:id/update-host', (req, res) => {
  const { host } = req.body;
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  if (!host || !isValidHost(host)) return res.status(400).json({ error: 'host 格式非法' });
  const node = db.getNodeById(id);
  if (node && host?.trim()) {
    const oldHost = node.host;
    db.updateNode(node.id, { host: host.trim(), ssh_host: host.trim() });
    db.addAuditLog(req.user.id, 'node_update_ip', `${node.name} IP变更: ${oldHost} → ${host.trim()}`, req.ip);
  }
  res.redirect('/admin#nodes');
});

router.post('/nodes/:id/update-level', async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
  if (user) {
    db.resetSubToken(user.id);
    db.addAuditLog(req.user.id, 'token_reset', `重置订阅: ${user.username}`, req.ip);
  }
  res.redirect('/admin#users');
});

// 设置单用户流量限额
router.post('/users/:id/traffic-limit', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const limitGB = parseFloat(req.body.limit) || 0;
  const limitBytes = Math.round(limitGB * 1073741824);
  db.setUserTrafficLimit(user.id, limitBytes);
  db.addAuditLog(req.user.id, 'traffic_limit', `设置 ${user.username} 流量限额: ${limitGB > 0 ? limitGB + ' GB' : '无限'}`, req.ip);
  res.json({ ok: true });
});

// 设置全局默认流量限额
router.post('/default-traffic-limit', (req, res) => {
  const limitGB = parseFloat(req.body.limit) || 0;
  const limitBytes = Math.round(limitGB * 1073741824);
  db.setSetting('default_traffic_limit', String(limitBytes));
  db.addAuditLog(req.user.id, 'default_traffic_limit', `设置默认流量限额: ${limitGB > 0 ? limitGB + ' GB' : '无限'}`, req.ip);
  res.json({ ok: true });
});

// 将默认流量限额应用到所有未设置限额的用户（traffic_limit=0）
router.post('/default-traffic-limit/apply', (req, res) => {
  const limitBytes = parseInt(db.getSetting('default_traffic_limit')) || 0;
  const r = db.getDb().prepare('UPDATE users SET traffic_limit = ?').run(limitBytes);
  db.addAuditLog(req.user.id, 'default_traffic_limit_apply', `批量应用默认流量限额到全部用户: ${r.changes} 个`, req.ip);
  res.json({ ok: true, updated: r.changes });
});

// ========== 手动健康检测 ==========

// ========== 手动健康检测（通过 Agent ping） ==========

router.post('/health-check', async (req, res) => {
  const agentWs = require('../services/agent-ws');
  try {
    const agents = agentWs.getConnectedAgents();
    const nodes = db.getAllNodes();
    const onlineNodeIds = new Set(agents.map(a => a.nodeId));
    const results = [];

    // 向所有在线 agent 发 ping
    const pings = agents.map(async (a) => {
      const result = await agentWs.sendCommand(a.nodeId, { type: 'ping' });
      return { nodeId: a.nodeId, name: a.nodeName, online: result.success, agent: true };
    });
    const pingResults = await Promise.all(pings);
    results.push(...pingResults);

    // 不在线的节点标记离线
    for (const n of nodes) {
      if (!onlineNodeIds.has(n.id)) {
        results.push({ nodeId: n.id, name: n.name, online: false, agent: false });
      }
    }

    db.addAuditLog(req.user.id, 'health_check', `Agent 健康检测: ${agents.length}/${nodes.length} 在线`, req.ip);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[健康检测]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 手动轮换 ==========

router.post('/rotate', (req, res) => {
  const rotateService = require('../services/rotate');
  db.addAuditLog(req.user.id, 'manual_rotate', '手动轮换（后台执行中）', req.ip);
  res.redirect('/admin#nodes');
  rotateService.rotateManual().catch(err => console.error('[手动轮换] 失败:', err));
});

// ========== AWS 配置 ==========

router.get('/aws/config', (req, res) => {
  const accounts = db.getAwsAccounts();
  res.json({
    configured: accounts.length > 0,
    count: accounts.length,
    accounts: accounts.map(a => ({
      id: a.id,
      name: a.name,
      defaultRegion: a.default_region,
      socks5_host: a.socks5_host,
      socks5_port: a.socks5_port,
      enabled: !!a.enabled,
      accessKeyMasked: a.access_key ? a.access_key.substring(0, 4) + '***' + a.access_key.slice(-4) : ''
    }))
  });
});

function parseSocks5Url(socks5Url) {
  if (!socks5Url) return { host: null, port: 1080, user: null, pass: null };
  const u = new URL(socks5Url);
  if (!['socks5:', 'socks:'].includes(u.protocol)) throw new Error('仅支持 socks5:// 或 socks://');
  if (!u.hostname || !u.port) throw new Error('请包含主机和端口');
  return {
    host: u.hostname,
    port: parseInt(u.port) || 1080,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null
  };
}

router.post('/aws/config', (req, res) => {
  const { name, accessKey, secretKey, socks5Url } = req.body;
  if (!name || !accessKey || !secretKey) {
    return res.status(400).json({ error: '请填写账号名、Access Key、Secret Key' });
  }

  let socks = { host: null, port: 1080, user: null, pass: null };
  try {
    socks = parseSocks5Url(socks5Url);
  } catch (e) {
    return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
  }

  const aws = require('../services/aws');
  aws.setAwsConfig({
    name,
    accessKey,
    secretKey,
    defaultRegion: 'us-east-1',
    socks5Host: socks.host,
    socks5Port: socks.port,
    socks5User: socks.user,
    socks5Pass: socks.pass
  });
  db.addAuditLog(req.user.id, 'aws_config', `新增 AWS 账号: ${name}`, req.ip);
  res.json({ ok: true });
});

router.put('/aws/config/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const current = db.getAwsAccountById(id);
  if (!current) return res.status(404).json({ error: '账号不存在' });

  const { name, socks5Url } = req.body || {};
  let socks;
  try {
    // 允许清空 socks：传空字符串
    socks = socks5Url === '' ? { host: null, port: 1080, user: null, pass: null } : parseSocks5Url(socks5Url);
  } catch (e) {
    return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
  }

  db.updateAwsAccount(id, {
    name: name || current.name,
    socks5_host: socks.host,
    socks5_port: socks.port,
    socks5_user: socks.user,
    socks5_pass: socks.pass
  });

  db.addAuditLog(req.user.id, 'aws_config_edit', `编辑 AWS 账号 #${id}`, req.ip);
  res.json({ ok: true });
});

router.delete('/aws/config/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  db.deleteAwsAccount(id);
  db.addAuditLog(req.user.id, 'aws_config_delete', `删除 AWS 账号 #${id}`, req.ip);
  res.json({ ok: true });
});

router.post('/aws/socks-test', async (req, res) => {
  const { socks5Url } = req.body || {};
  if (!socks5Url) return res.status(400).json({ error: '请填写 SOCKS5 URL' });

  let url;
  try {
    url = new URL(socks5Url);
    if (!['socks5:', 'socks:'].includes(url.protocol)) throw new Error('仅支持 socks5:// 或 socks://');
    if (!url.hostname || !url.port) throw new Error('请包含主机和端口');
  } catch (e) {
    return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
  }

  try {
    const https = require('https');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const agent = new SocksProxyAgent(socks5Url);

    const ip = await new Promise((resolve, reject) => {
      const r = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const j = JSON.parse(data || '{}');
            if (!j.ip) return reject(new Error('未获取到出口 IP'));
            resolve(j.ip);
          } catch {
            reject(new Error('返回格式异常'));
          }
        });
      });
      r.on('timeout', () => r.destroy(new Error('连接超时')));
      r.on('error', reject);
    });

    res.json({ ok: true, ip });
  } catch (e) {
    res.status(500).json({ error: e.message || '验证失败' });
  }
});

// 列出 EC2/Lightsail 实例
router.get('/aws/instances', async (req, res) => {
  const aws = require('../services/aws');
  const region = req.query.region || undefined;
  const type = req.query.type || 'ec2';
  const accountId = parseInt(req.query.accountId) || undefined;
  try {
    const instances = type === 'lightsail'
      ? await aws.listLightsailInstances(region, accountId)
      : await aws.listEC2Instances(region, accountId);
    res.json(instances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 绑定节点到 AWS 实例
router.post('/nodes/:id/aws-bind', async (req, res) => {
  const { aws_instance_id, aws_type, aws_region, aws_account_id } = req.body;
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  db.updateNode(node.id, {
    aws_instance_id: aws_instance_id || null,
    aws_type: aws_type || 'ec2',
    aws_region: aws_region || null,
    aws_account_id: aws_account_id ? parseInt(aws_account_id) : null
  });
  // 自动打 Name 标签
  if (aws_instance_id) {
    try {
      const aws = require('../services/aws');
      await aws.tagInstance(aws_instance_id, { Name: node.name }, aws_type || 'ec2', aws_region, aws_account_id ? parseInt(aws_account_id) : undefined);
    } catch (e) {
      console.log(`[AWS绑定] 打标签失败: ${e.message}`);
    }
  }
  db.addAuditLog(req.user.id, 'aws_bind', `绑定 AWS: ${node.name} → ${aws_instance_id} (${aws_type}) [账号:${aws_account_id || '默认'}]`, req.ip);
  res.json({ ok: true });
});

// 手动换 IP
router.post('/nodes/:id/swap-ip', async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!node.aws_instance_id) return res.status(400).json({ error: '节点未绑定 AWS 实例' });

  const aws = require('../services/aws');
  db.addAuditLog(req.user.id, 'aws_swap_ip', `手动换 IP: ${node.name}`, req.ip);

  try {
    const result = await aws.swapNodeIp(node, node.aws_instance_id, node.aws_type, node.aws_region, node.aws_account_id);
    const { notify } = require('../services/notify');
    if (result.success) {
      notify.ops(`🔄 ${node.name} 手动换 IP: ${result.oldIp} → ${result.newIp}`).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取所有账号的所有实例（仪表盘用）
// AWS 实例缓存
let _awsInstancesCache = { data: null, ts: 0 };

router.get('/aws/all-instances', async (req, res) => {
  const aws = require('../services/aws');
  const force = req.query.force === '1';
  try {
    // 非强制刷新且缓存有效（10分钟内）则返回缓存
    if (!force && _awsInstancesCache.data && Date.now() - _awsInstancesCache.ts < 600000) {
      return res.json(_awsInstancesCache.data);
    }
    const results = await aws.listAllInstances();
    _awsInstancesCache = { data: results, ts: Date.now() };
    res.json(results);
  } catch (e) {
    // 出错时如果有旧缓存也返回
    if (_awsInstancesCache.data) return res.json(_awsInstancesCache.data);
    res.status(500).json({ error: e.message });
  }
});

// EC2/Lightsail 开机
router.post('/aws/start', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  const aws = require('../services/aws');
  try {
    if (type === 'lightsail') {
      await aws.startLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    } else {
      await aws.startEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    }
    db.addAuditLog(req.user.id, 'aws_start', `开机: ${instanceId} (${type})`, req.ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// EC2/Lightsail 关机
router.post('/aws/stop', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  const aws = require('../services/aws');
  try {
    if (type === 'lightsail') {
      await aws.stopLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    } else {
      await aws.stopEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    }
    db.addAuditLog(req.user.id, 'aws_stop', `关机: ${instanceId} (${type})`, req.ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 终止实例（支持 Lightsail）
router.post('/aws/terminate', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  const aws = require('../services/aws');
  try {
    if (type === 'lightsail') {
      await aws.terminateLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    } else {
      await aws.terminateEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    }
    db.addAuditLog(req.user.id, 'aws_terminate', `终止实例: ${instanceId} (${type})`, req.ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 实例换 IP（从仪表盘直接操作，非节点维度）
router.post('/aws/swap-ip', async (req, res) => {
  const { instanceId, type, region, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  const aws = require('../services/aws');

  // 查找绑定的节点
  const allNodes = db.getAllNodes();
  const node = allNodes.find(n => n.aws_instance_id === instanceId);

  try {
    if (node) {
      // 有绑定节点，走完整换 IP 流程
      const result = await aws.swapNodeIp(node, instanceId, type, region, accountId ? parseInt(accountId) : undefined);
      res.json(result);
    } else {
      // 没有绑定节点，只换 IP
      let result;
      if (type === 'lightsail') {
        result = await aws.swapLightsailIp(instanceId, region, accountId ? parseInt(accountId) : undefined);
      } else {
        result = await aws.swapEC2Ip(instanceId, region, accountId ? parseInt(accountId) : undefined);
      }
      db.addAuditLog(req.user.id, 'aws_swap_ip', `换IP: ${instanceId} ${result.oldIp} → ${result.newIp}`, req.ip);
      res.json({ success: true, newIp: result.newIp, oldIp: result.oldIp });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 一键创建并部署实例
router.post('/aws/launch-and-deploy', async (req, res) => {
  const { accountId, region, type, spec, sshPassword } = req.body;
  if (!accountId || !region || !type) return res.status(400).json({ error: '参数不完整' });
  if (!sshPassword) return res.status(400).json({ error: '请填写 SSH 密码（用于部署）' });

  // 立即返回，后台执行
  res.json({ ok: true, message: '创建中...' });

  const aws = require('../services/aws');
  const deployService = require('../services/deploy');

  try {
    db.addAuditLog(req.user.id, 'aws_launch', `开始创建: ${type} ${spec} in ${region} (账号#${accountId})`, req.ip);

    // 1. 创建实例
    let instanceId;
    if (type === 'lightsail') {
      const name = `panel-${Date.now()}`;
      await aws.launchLightsailInstance(region, spec, name, parseInt(accountId));
      instanceId = name;
    } else {
      const result = await aws.launchEC2Instance(region, spec, parseInt(accountId));
      instanceId = result.instanceId;
    }
    console.log(`[一键部署] 实例已创建: ${instanceId}`);

    // 2. 等待就绪
    const inst = await aws.waitForInstanceRunning(instanceId, type, region, parseInt(accountId));
    const publicIp = inst.publicIp || inst.publicIpAddress;
    console.log(`[一键部署] 实例就绪: ${instanceId} IP: ${publicIp}`);

    if (!publicIp) throw new Error('实例无公网 IP');

    // 3. 等待 SSH 可用
    const { checkPort } = require('../services/health');
    let sshReady = false;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      sshReady = await checkPort(publicIp, 22, 5000);
      if (sshReady) break;
    }
    if (!sshReady) throw new Error('SSH 120秒内未就绪');

    // 4. 部署 xray + 添加面板节点
    await deployService.deployNode({
      host: publicIp,
      ssh_password: sshPassword,
      ssh_port: 22,
      ssh_user: type === 'lightsail' ? 'ubuntu' : 'ubuntu',
      triggered_by: req.user.id
    }, db);

    // 5. 找到刚创建的节点，绑定 AWS 信息
    const allNodes = db.getAllNodes();
    const newNode = allNodes.find(n => n.host === publicIp);
    if (newNode) {
      db.updateNode(newNode.id, {
        aws_instance_id: instanceId,
        aws_type: type,
        aws_region: region,
        aws_account_id: parseInt(accountId)
      });
      // 6. 打 Name 标签
      try {
        await aws.tagInstance(instanceId, { Name: newNode.name }, type, region, parseInt(accountId));
      } catch (e) {
        console.log(`[一键部署] 打标签失败: ${e.message}`);
      }
    }

    db.addAuditLog(req.user.id, 'aws_launch_done', `一键部署完成: ${instanceId} IP: ${publicIp}`, req.ip);
    try { const { notify } = require('../services/notify'); notify.ops(`🚀 一键部署完成: ${instanceId} (${publicIp})`).catch(() => {}); } catch {}
  } catch (e) {
    console.error(`[一键部署] 失败: ${e.message}`);
    db.addAuditLog(req.user.id, 'aws_launch_fail', `一键部署失败: ${e.message}`, req.ip);
    try { const { notify } = require('../services/notify'); notify.ops(`❌ 一键部署失败: ${e.message}`).catch(() => {}); } catch {}
  }
});

// 查看某用户的订阅拉取 IP
router.get('/sub-access/:userId', (req, res) => {
  const userId = parseIntId(req.params.userId);
  if (!userId) return res.status(400).json({ error: '参数错误' });
  const hours = parseInt(req.query.hours) || 24;
  res.json(db.getSubAccessIPs(userId, hours));
});

// ========== Agent WebSocket 管理 ==========

router.get('/agents', (req, res) => {
  const { getConnectedAgents } = require('../services/agent-ws');
  res.json({ agents: getConnectedAgents() });
});

router.post('/agents/:nodeId/command', async (req, res) => {
  const nodeId = parseIntId(req.params.nodeId);
  if (!nodeId) return res.status(400).json({ error: '参数错误' });
  const command = req.body;
  if (!command || !command.type) {
    return res.status(400).json({ error: '缺少 command.type' });
  }
  const { sendCommand } = require('../services/agent-ws');
  const result = await sendCommand(nodeId, command);
  db.addAuditLog(req.user.id, 'agent_command', `节点#${nodeId} 指令: ${command.type}`, req.ip);
  res.json(result);
});

// 重启 Xray
router.post('/nodes/:id/restart-xray', async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const agentWs = require('../services/agent-ws');
  if (!agentWs.isAgentOnline(node.id)) {
    return res.json({ success: false, error: 'Agent 不在线' });
  }
  const result = await agentWs.sendCommand(node.id, { type: 'restart_xray' });
  db.addAuditLog(req.user.id, 'restart_xray', `重启 Xray: ${node.name}`, req.ip);
  res.json(result);
});

// 批量更新 Agent
router.post('/agents/update-all', async (req, res) => {
  const agentWs = require('../services/agent-ws');
  const agents = agentWs.getConnectedAgents();
  if (agents.length === 0) return res.json({ ok: true, results: [], message: '无在线 Agent' });

  const results = await Promise.all(agents.map(async (a) => {
    const r = await agentWs.sendCommand(a.nodeId, { type: 'self_update' });
    return { nodeId: a.nodeId, name: a.nodeName, success: r.success, error: r.error };
  }));
  db.addAuditLog(req.user.id, 'agent_update_all', `批量更新 Agent: ${agents.length} 个`, req.ip);
  res.json({ ok: true, results });
});

router.post('/agent-token/regenerate', (req, res) => {
  const newToken = uuidv4();
  db.setSetting('agent_token', newToken);
  db.addAuditLog(req.user.id, 'agent_token_regen', '重新生成 Agent Token', req.ip);
  res.json({ token: newToken });
});

// ========== 日志 API ==========

router.get('/logs', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const type = req.query.type || 'all';
  const limit = 50;
  const offset = (page - 1) * limit;
  const logs = db.getAuditLogs(limit, offset, type);
  res.json(logs);
});

router.post('/logs/clear', (req, res) => {
  db.clearAuditLogs();
  db.addAuditLog(req.user.id, 'logs_clear', '清空日志', req.ip);
  res.json({ ok: true });
});

// ========== 通知 API ==========

router.post('/notify/config', (req, res) => {
  const { token, chatId } = req.body;
  if (token) db.setSetting('tg_bot_token', token);
  if (chatId) db.setSetting('tg_chat_id', chatId);
  res.json({ ok: true });
});

router.post('/notify/test', async (req, res) => {
  try {
    const { send } = require('../services/notify');
    await send('🔔 测试通知 - 来自小姨子の后台');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/notify/event', (req, res) => {
  const { key, enabled } = req.body;
  if (key && key.startsWith('tg_on_')) {
    db.setSetting(key, enabled ? 'true' : 'false');
  }
  res.json({ ok: true });
});

// ========== 公告 & 限制 ==========

router.post('/announcement', (req, res) => {
  db.setSetting('announcement', req.body.text || '');
  res.json({ ok: true });
});

router.post('/max-users', (req, res) => {
  db.setSetting('max_users', String(parseInt(req.body.max) || 0));
  res.json({ ok: true });
});

// ========== 流量 API ==========

router.get('/traffic', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const range = req.query.range || req.query.date || 'today';
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getUsersTrafficByRange(range, limit, offset);
  res.json({ ...data, page });
});

router.get('/traffic/nodes', (req, res) => {
  const range = req.query.range || 'today';
  const data = db.getNodesTrafficByRange(range);
  res.json(data);
});

// ========== 订阅统计 API ==========

router.get('/sub-stats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const page = parseInt(req.query.page) || 1;
  const sort = req.query.sort || 'count';
  const onlyHigh = req.query.high === '1';
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getSubAccessStats(hours, limit, offset, onlyHigh, sort);
  res.json({ ...data, page, limit });
});

router.get('/sub-stats/:userId/detail', (req, res) => {
  const userId = parseIntId(req.params.userId);
  if (!userId) return res.status(400).json({ error: '参数错误' });
  const hours = parseInt(req.query.hours) || 24;
  const data = db.getSubAccessUserDetail(userId, hours);
  res.json(data);
});

// ========== AI 运营日记 ==========

router.get('/diary', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getDiaryEntries(limit, offset);
  const stats = db.getDiaryStats();
  res.json({ ...data, page, stats });
});

// ========== AI 运维配置 ==========

router.get('/ops-config', (req, res) => {
  const keys = ['ops_target_nodes', 'ops_patrol_interval', 'ops_max_daily_swaps', 'ops_max_daily_creates',
    'ops_auto_swap_ip', 'ops_auto_repair', 'ops_auto_scale', 'ops_panel_guard'];
  const cfg = {};
  for (const k of keys) cfg[k] = db.getSetting(k) || '';
  res.json(cfg);
});

router.post('/ops-config', (req, res) => {
  const allowed = ['ops_target_nodes', 'ops_patrol_interval', 'ops_max_daily_swaps', 'ops_max_daily_creates',
    'ops_auto_swap_ip', 'ops_auto_repair', 'ops_auto_scale', 'ops_panel_guard'];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) db.setSetting(k, String(v));
  }
  db.addAuditLog(req.user.id, 'ops_config', '更新 AI 运维配置', req.ip);
  res.json({ ok: true });
});

module.exports = router;
