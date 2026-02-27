/**
 * WebSocket Agent 服务
 * 管理节点 agent 的 WebSocket 连接，接收上报数据，下发指令
 */
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const net = require('net');
const db = require('./database');
const healthService = require('./health');
const { notify } = require('./notify');
const logger = require('./logger');

let _deploy;
let _uuidRepo;
const getDeploy = () => _deploy || (_deploy = require('./deploy'));
const getUuidRepo = () => _uuidRepo || (_uuidRepo = require('./repos/uuidRepo'));

// 在线 agent 连接池：nodeId → { ws, nodeId, connectedAt, lastReport, reportData }
const agents = new Map();
// 节点连接指标：nodeId → { disconnectCount, lastDisconnectAt, lastReconnectAt, consecutiveReconnects }
const agentMetrics = new Map();

// 待响应的指令回调：cmdId → { resolve, timer, nodeId }
const pendingCommands = new Map();

const AUTH_TIMEOUT = 10000; // 认证超时 10s
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;
const CMD_TIMEOUT = 30000;

let wss = null;
let pingTimer = null;

const bjNow = () => new Date(Date.now() + 8 * 3600000).toISOString();
const bjNowFmt = () => bjNow().replace('T', ' ').substring(0, 19);

function getOrCreateMetrics(nodeId) {
  if (!agentMetrics.has(nodeId)) {
    agentMetrics.set(nodeId, {
      disconnectCount: 0,
      lastDisconnectAt: null,
      lastReconnectAt: null,
      consecutiveReconnects: 0,
    });
  }
  return agentMetrics.get(nodeId);
}

function markDisconnected(nodeId) {
  const metrics = getOrCreateMetrics(nodeId);
  metrics.disconnectCount += 1;
  metrics.consecutiveReconnects += 1;
  metrics.lastDisconnectAt = bjNow();
}

function cleanupPendingCommands(nodeId) {
  for (const [id, pending] of pendingCommands) {
    if (pending.nodeId !== nodeId) continue;
    clearTimeout(pending.timer);
    pendingCommands.delete(id);
    try {
      pending.resolve({ success: false, error: 'Agent 连接已断开' });
    } catch {}
  }
}

function checkTcpPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
  });
}

function autoFixVlessIpv4(nodeId, node) {
  if (!node || node.protocol !== 'vless' || !node.host || !node.host.includes(':')) return;

  setTimeout(async () => {
    try {
      const result = await sendCommand(nodeId, { type: 'exec', command: 'curl -4 -s --max-time 5 ifconfig.me' });
      const ipv4 = result.success && result.data?.stdout?.trim();
      if (ipv4 && /^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) {
        db.updateNode(nodeId, { host: ipv4 });
        logger.info(`[🍑 蜜桃酱] VLESS 捐赠节点 #${nodeId} IPv4 修正: ${node.host} → ${ipv4}`);
        const freshNode = db.getNodeById(nodeId);
        getDeploy().syncNodeConfig(freshNode, db).catch(() => {});
      }
    } catch (e) {
      logger.info(`[🍑 蜜桃酱] IPv4 修正失败: ${e.message}`);
    }
  }, 3000);
}

function bindDonationToNode(ws, donation, ip, version, capabilities) {
  const donateNodeId = donation.node_id;
  ws._agentState.nodeId = donateNodeId;

  const oldDonate = agents.get(donateNodeId);
  if (oldDonate && oldDonate.ws !== ws) {
    try { oldDonate.ws.close(4007, '被新连接替代'); } catch {}
  }

  const donateNode = db.getNodeById(donateNodeId);
  agents.set(donateNodeId, {
    ws,
    nodeId: donateNodeId,
    nodeName: donateNode ? donateNode.name : `捐赠#${donation.id}`,
    ip,
    connectedAt: bjNow(),
    lastReport: null,
    reportData: null,
    version: version || null,
    capabilities: capabilities || null,
    _pongReceived: true,
  });

  ws.send(JSON.stringify({ type: 'auth_ok', message: '捐赠节点已上线' }));
  logger.info(`[Agent-WS] 捐赠节点重连 node#${donateNodeId} from ${ip}`);

  autoFixVlessIpv4(donateNodeId, donateNode);
}

async function autoApproveDonation({ ws, donation, ip, protoChoice, tempId }) {
  const d = db.getDb();
  let createdNodeIds = [];
  try {
    if (protoChoice === 'ss' || protoChoice === 'dual') {
      try {
        const result = await sendCommand(tempId, { type: 'exec', command: "ip -6 addr show scope global | grep inet6 | head -1 | awk '{print $2}' | cut -d/ -f1" });
        const ipv6 = result.success && result.data?.stdout?.trim();
        if (ipv6) {
          d.prepare('UPDATE node_donations SET remark = ? WHERE id = ?').run(`IPv6: ${ipv6}`, donation.id);
          logger.info(`[Agent-WS] 捐赠节点 IPv6 检测成功: ${ipv6}`);
        } else {
          const failMsg = protoChoice === 'ss' ? '❌ 未检测到 IPv6，无法部署 SS 节点' : '⚠️ 未检测到 IPv6，仅支持 VLESS';
          if (protoChoice === 'ss') {
            // 纯 SS 且无 IPv6：自动结束审核，避免长期卡 pending
            d.prepare("UPDATE node_donations SET status = 'rejected', remark = ? WHERE id = ?").run(failMsg, donation.id);
            db.addAuditLog(null, 'donate_reject_auto', `自动拒绝捐赠: ${ip} (选择SS但无IPv6)`, 'system');
          } else {
            d.prepare('UPDATE node_donations SET remark = ? WHERE id = ?').run(failMsg, donation.id);
          }
          logger.info(`[Agent-WS] 捐赠节点 ${ip} 无 IPv6 (选择: ${protoChoice})`);
        }
      } catch (e) {
        logger.error(`[Agent-WS] IPv6 检测异常:`, e.message);
      }
    }

    const freshDonation = d.prepare('SELECT * FROM node_donations WHERE id = ?').get(donation.id);
    if (freshDonation && freshDonation.status === 'pending') {
      logger.info(`[🍑 蜜桃酱] 自动审核捐赠节点 #${donation.id} from ${ip}`);

      let region = freshDonation.region || '';
      if (!region && ip) {
        try {
          const geo = await getDeploy().detectRegion(ip);
          if (geo && geo.cityCN !== '未知') region = `${geo.emoji} ${geo.cityCN}`;
        } catch {}
      }

      const donor = d.prepare('SELECT username, name FROM users WHERE id = ?').get(freshDonation.user_id);
      const donorName = donor ? (donor.name || donor.username) : `用户${freshDonation.user_id}`;
      const natMode = Number(freshDonation.nat_mode || 0) === 1;
      const preferredNatPort = Number(freshDonation.nat_port || 0);
      const nodeIds = createdNodeIds;

      if (protoChoice === 'vless' || protoChoice === 'dual') {
        let vlessHost = ip;
        try {
          const ipv4Result = await sendCommand(tempId, { type: 'exec', command: 'curl -4 -s --max-time 5 ifconfig.me' });
          const detectedIpv4 = ipv4Result.success && ipv4Result.data?.stdout?.trim();
          if (detectedIpv4 && /^\d+\.\d+\.\d+\.\d+$/.test(detectedIpv4)) {
            vlessHost = detectedIpv4;
            logger.info(`[🍑 蜜桃酱] VLESS IPv4 检测: ${detectedIpv4}`);
          }
        } catch {
          logger.info(`[🍑 蜜桃酱] IPv4 检测失败，使用连接 IP: ${ip}`);
        }

        const nodeName = region ? `${region}-${donorName}` : donorName;
        let port = 10000 + Math.floor(Math.random() * 50000);
        if (natMode && Number.isInteger(preferredNatPort) && preferredNatPort >= 1 && preferredNatPort <= 65535) {
          const used = d.prepare('SELECT 1 FROM nodes WHERE host = ? AND port = ? LIMIT 1').get(vlessHost, preferredNatPort);
          if (!used) port = preferredNatPort;
        }
        const agentToken = uuidv4();
        const nodeResult = d.prepare(`
                INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, is_active, agent_token, group_name, remark, is_donation, ssh_host, rotate_port_locked)
                VALUES (?, ?, ?, ?, 'vless', 4, 1, ?, '捐赠节点', '', 1, ?, ?)
              `).run(nodeName, vlessHost, port, uuidv4(), agentToken, ip, natMode ? 1 : 0);
        const nodeId = Number(nodeResult.lastInsertRowid);
        nodeIds.push(nodeId);

        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
        const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
        const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
        db.updateNode(nodeId, {
          reality_private_key: privRaw.toString('base64url'),
          reality_public_key: pubRaw.toString('base64url'),
          reality_short_id: crypto.randomBytes(4).toString('hex'),
          sni: 'www.microsoft.com'
        });
        getUuidRepo().ensureAllUsersHaveUuid(nodeId);
      }

      if (protoChoice === 'ss' || protoChoice === 'dual') {
        const freshRemark = d.prepare('SELECT remark FROM node_donations WHERE id = ?').get(donation.id)?.remark || '';
        const ipv6Match = freshRemark.match(/IPv6:\s*(\S+)/);
        if (ipv6Match) {
          const ipv6Addr = ipv6Match[1];
          const ssName = protoChoice === 'dual'
            ? (region ? `${region}-${donorName}⁶` : `${donorName}⁶`)
            : (region ? `${region}-${donorName}` : donorName);
          let ssPort = 10000 + Math.floor(Math.random() * 50000);
          if (natMode && Number.isInteger(preferredNatPort) && preferredNatPort >= 1 && preferredNatPort <= 65535) {
            const used = d.prepare('SELECT 1 FROM nodes WHERE host = ? AND port = ? LIMIT 1').get(ipv6Addr, preferredNatPort);
            if (!used) ssPort = preferredNatPort;
          }
          const ssResult = d.prepare(`
                  INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, ss_method, is_active, agent_token, group_name, remark, is_donation, ssh_host, rotate_port_locked)
                  VALUES (?, ?, ?, ?, 'ss', 6, 'aes-256-gcm', 1, ?, '捐赠节点', '', 1, ?, ?)
                `).run(ssName, ipv6Addr, ssPort, uuidv4(), uuidv4(), ip, natMode ? 1 : 0);
          const ssNodeId = Number(ssResult.lastInsertRowid);
          nodeIds.push(ssNodeId);
          getUuidRepo().ensureAllUsersHaveUuid(ssNodeId);
        }
      }

      if (nodeIds.length > 0) {
        // 1) 先推送配置
        for (const nid of nodeIds) {
          try {
            const n = db.getNodeById(nid);
            const ok = await getDeploy().syncNodeConfig(n, db);
            logger.info(`[🍑 蜜桃酱] 配置推送 ${ok ? '✅' : '❌'}: ${n.name}`);
            if (!ok) throw new Error(`配置推送失败: ${n.name}`);
          } catch (e) {
            throw new Error(`配置推送异常: ${e.message}`);
          }
        }

        // 2) 审核前硬校验：xray 可重启 + 节点端口可连通
        const restartCheck = await sendCommand(tempId, { type: 'restart_xray' });
        if (!restartCheck.success) {
          throw new Error(`xray.service 校验失败: ${restartCheck.error || 'restart_xray failed'}`);
        }

        for (const nid of nodeIds) {
          const n = db.getNodeById(nid);
          const ok = await checkTcpPort(n.host, n.port, 5000);
          if (!ok) {
            throw new Error(`端口探测失败: ${n.name} ${n.host}:${n.port}`);
          }
        }

        // 3) 通过后再正式上线
        const tx = d.transaction(() => {
          d.prepare("UPDATE node_donations SET status = 'online', node_id = ?, region = ?, approved_at = datetime('now', 'localtime') WHERE id = ?")
            .run(nodeIds[0], region, donation.id);
          d.prepare('UPDATE users SET is_donor = 1 WHERE id = ?').run(freshDonation.user_id);
        });
        tx();

        db.addAuditLog(null, 'donate_auto_approve', `🍑 蜜桃酱自动审核通过: ${ip}, 协议: ${protoChoice}, 捐赠者: ${donorName}`, 'system');

        const mainNodeId = nodeIds[0];
        ws._agentState.nodeId = mainNodeId;
        const node = db.getNodeById(mainNodeId);
        agents.delete(tempId);
        agents.set(mainNodeId, { ws, nodeId: mainNodeId, nodeName: node?.name || `捐赠#${donation.id}`, ip, connectedAt: bjNow(), lastReport: null, reportData: null, _pongReceived: true });

        try {
          notify.deploy && notify.deploy(node?.name || ip, true, `🍑 蜜桃酱自动审核 | 协议: ${protoChoice} | 捐赠者: ${donorName}`);
        } catch {}

        logger.info(`[🍑 蜜桃酱] 自动审核完成: ${nodeIds.length} 个节点上线`);
      }
    }
  } catch (e) {
    try {
      if (createdNodeIds.length > 0) {
        const txCleanup = d.transaction((ids) => {
          const delUuid = d.prepare('DELETE FROM user_node_uuid WHERE node_id = ?');
          const delNode = d.prepare('DELETE FROM nodes WHERE id = ?');
          for (const nid of ids) {
            delUuid.run(nid);
            delNode.run(nid);
          }
        });
        txCleanup(createdNodeIds);
      }
      d.prepare("UPDATE node_donations SET status = 'rejected', remark = ? WHERE id = ? AND status = 'pending'")
        .run(`❌ 自动审核失败: ${String(e.message || 'unknown').slice(0, 160)}`, donation.id);
      db.addAuditLog(null, 'donate_reject_auto', `自动拒绝捐赠: ${ip} (校验失败: ${e.message})`, 'system');
    } catch (_) {}
    logger.error(`[🍑 蜜桃酱] 自动审核异常:`, e.message, e.stack);
  }
}

function handleDonationAuth(ws, msg) {
  const { token, version, capabilities } = msg;
  const d = db.getDb();
  const ip = ws._agentState.ip;

  let donation = d.prepare('SELECT * FROM node_donations WHERE token = ?').get(token);
  if (!donation) {
    const tokenRecord = d.prepare('SELECT * FROM donate_tokens WHERE token = ?').get(token);
    if (!tokenRecord) {
      return ws.close(4005, '无效的捐赠令牌');
    }
    d.prepare("INSERT INTO node_donations (user_id, token, server_ip, status, protocol_choice, nat_mode, nat_port) VALUES (?, ?, ?, 'pending', ?, ?, ?)").run(tokenRecord.user_id, token, ip, tokenRecord.protocol_choice || 'vless', Number(tokenRecord.nat_mode || 0), Number(tokenRecord.nat_port || 0) || null);
    donation = d.prepare('SELECT * FROM node_donations WHERE token = ?').get(token);
  } else {
    if (donation.status === 'online') {
      d.prepare("UPDATE node_donations SET server_ip = ? WHERE id = ?").run(ip, donation.id);
    } else {
      d.prepare("UPDATE node_donations SET server_ip = ?, status = 'pending' WHERE id = ?").run(ip, donation.id);
    }
  }

  clearTimeout(ws._authTimer);
  ws._agentState.authenticated = true;
  ws._agentState.isDonation = true;

  if (donation.status === 'online' && donation.node_id) {
    bindDonationToNode(ws, donation, ip, version, capabilities);
  } else {
    ws._agentState.nodeId = `donate-${donation.id}`;
    ws.send(JSON.stringify({ type: 'auth_ok', message: '捐赠节点已连接，蜜桃酱正在自动审核...' }));
    logger.info(`[Agent-WS] 捐赠节点连接 from ${ip}, 用户#${donation.user_id}, 令牌: ${token}`);
    db.addAuditLog(donation.user_id, 'donate_connect', `捐赠节点连接: IP ${ip}`, ip);

    // BUG1: tokenRecord 在此作用域不存在，已有 donation 时直接使用 donation.protocol_choice
    const protoChoice = donation.protocol_choice || 'vless';

    const tempId = `donate-${donation.id}`;
    agents.set(tempId, { ws, nodeId: tempId, nodeName: `捐赠#${donation.id}`, ip, connectedAt: bjNow(), lastReport: null, reportData: null, _pongReceived: true });

    setTimeout(() => autoApproveDonation({ ws, donation, ip, protoChoice, tempId }), 5000);
  }

  try {
    const { detectRegion } = getDeploy();
    detectRegion(ip).then(geo => {
      if (geo && geo.city !== 'Unknown') {
        const region = `${geo.emoji} ${geo.cityCN}`;
        d.prepare('UPDATE node_donations SET region = ? WHERE id = ?').run(region, donation.id);
        logger.info(`[Agent-WS] 捐赠节点地区检测: ${ip} → ${region}`);
      }
    }).catch(() => {});
  } catch {}

  // BUG2: 已在线重连不重复通知
  if (donation.status !== 'online') {
    notify.donateConnect && notify.donateConnect(ip, donation.user_id);
  }
}

function handleNormalAuth(ws, msg) {
  const { token, nodeId, version, capabilities } = msg;
  if (!nodeId) {
    return ws.close(4004, '缺少 nodeId');
  }

  const node = db.getNodeById(nodeId);
  if (!node) {
    return ws.close(4006, '节点不存在');
  }

  const nodeToken = node.agent_token;
  const globalToken = db.getSetting('agent_token');
  if (token !== nodeToken && token !== globalToken) {
    logger.info(`[Agent-WS] 节点 #${nodeId} 认证失败：token 不匹配`);
    return ws.close(4005, '认证失败');
  }

  const old = agents.get(nodeId);
  if (old && old.ws !== ws) {
    try { old.ws.close(4007, '被新连接替代'); } catch {}
  }

  clearTimeout(ws._authTimer);
  ws._agentState.authenticated = true;
  ws._agentState.nodeId = nodeId;

  const metrics = getOrCreateMetrics(nodeId);
  if (metrics.consecutiveReconnects > 0) {
    metrics.lastReconnectAt = bjNow();
    metrics.consecutiveReconnects = 0;
  }

  agents.set(nodeId, {
    ws,
    nodeId,
    nodeName: node.name,
    ip: ws._agentState.ip,
    connectedAt: bjNow(),
    lastReport: null,
    reportData: null,
    version: version || null,
    capabilities: capabilities || null,
    reconnectMetrics: { ...metrics },
    _pongReceived: true,
  });

  ws.send(JSON.stringify({ type: 'auth_ok' }));
  logger.info(`[Agent-WS] 节点 #${nodeId} (${node.name}) 认证成功`);
  db.addAuditLog(null, 'agent_online', `节点 Agent 上线: ${node.name} (${ws._agentState.ip})`, 'system');
}

/**
 * 初始化 WebSocket 服务，挂载到 HTTP server
 */
function init(server) {
  wss = new WebSocketServer({ server, path: '/ws/agent' });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    logger.info(`[Agent-WS] 新连接 from ${ip}`);

    ws._agentState = { authenticated: false, nodeId: null, ip };

    ws._authTimer = setTimeout(() => {
      if (!ws._agentState.authenticated) {
        logger.info(`[Agent-WS] 认证超时，断开 ${ip}`);
        ws.close(4001, '认证超时');
      }
    }, AUTH_TIMEOUT);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return ws.close(4002, '无效 JSON');
      }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(ws._authTimer);
      const { nodeId } = ws._agentState;
      if (nodeId && agents.get(nodeId)?.ws === ws) {
        markDisconnected(nodeId);
        agents.delete(nodeId);
        cleanupPendingCommands(nodeId);
        logger.info(`[Agent-WS] 节点 #${nodeId} 断开连接`);
        setTimeout(() => {
          if (!agents.has(nodeId)) {
            try {
              const node = db.getNodeById(nodeId);
              if (node && node.is_active) {
                db.updateNode(nodeId, {
                  is_active: 0,
                  remark: '🔴 断开',
                  last_check: bjNowFmt(),
                });
                db.addAuditLog(null, 'agent_offline', `节点 Agent 断开: ${node.name}`, 'system');
                notify.nodeDown(`${node.name} (Agent 断开)`);
              }
            } catch {}
          }
        }, 30000);
      }
    });

    ws.on('error', (err) => {
      logger.error(`[Agent-WS] 连接错误:`, err.message);
    });
  });

  pingTimer = setInterval(() => {
    for (const [nodeId, agent] of agents) {
      if (agent.ws.readyState !== 1) {
        markDisconnected(nodeId);
        agents.delete(nodeId);
        cleanupPendingCommands(nodeId);
        continue;
      }
      agent._pongReceived = false;
      try {
        agent.ws.send(JSON.stringify({ type: 'ping', id: uuidv4() }));
      } catch {
        markDisconnected(nodeId);
        agents.delete(nodeId);
        cleanupPendingCommands(nodeId);
        continue;
      }
      setTimeout(() => {
        if (agents.has(nodeId) && !agents.get(nodeId)._pongReceived) {
          logger.info(`[Agent-WS] 节点 #${nodeId} pong 超时，断开`);
          markDisconnected(nodeId);
          try { agent.ws.terminate(); } catch {}
          agents.delete(nodeId);
          cleanupPendingCommands(nodeId);
        }
      }, PONG_TIMEOUT);
    }
  }, PING_INTERVAL);

  logger.info('[Agent-WS] WebSocket 服务已启动，路径: /ws/agent');
}

/**
 * 处理 agent 消息
 */
function handleMessage(ws, msg) {
  const { type } = msg;

  if (!ws._agentState.authenticated && type !== 'auth') {
    return ws.close(4003, '未认证');
  }

  switch (type) {
    case 'auth':
      handleAuth(ws, msg);
      break;
    case 'report':
      handleReport(ws, msg);
      break;
    case 'cmd_result':
      handleCmdResult(ws, msg);
      break;
    case 'pong':
    case 'heartbeat':
      handlePong(ws);
      break;
    default:
      logger.info(`[Agent-WS] 未知消息类型: ${type}`);
  }
}

/**
 * 处理认证（分发器）
 */
function handleAuth(ws, msg) {
  const { token } = msg;

  if (!token) {
    return ws.close(4004, '缺少 token');
  }

  if (token.startsWith('donate-')) {
    return handleDonationAuth(ws, msg);
  }

  return handleNormalAuth(ws, msg);
}

/**
 * 处理 agent 上报数据
 */
function handleReport(ws, msg) {
  const { nodeId } = ws._agentState;
  const agent = agents.get(nodeId);
  if (!agent) return;

  const { xrayAlive, cnReachable, loadAvg, memUsage, diskUsage, trafficRecords, version, capabilities, reconnectMetrics, configHash } = msg;
  const now = bjNow();

  const reportData = { xrayAlive, cnReachable, loadAvg, memUsage, diskUsage, reportedAt: now };
  agent.lastReport = now;
  agent.reportData = reportData;
  if (version) agent.version = version;
  if (capabilities) agent.capabilities = capabilities;
  if (reconnectMetrics) {
    agent.reconnectMetrics = reconnectMetrics;
    const metrics = getOrCreateMetrics(nodeId);
    Object.assign(metrics, reconnectMetrics);
  } else {
    agent.reconnectMetrics = { ...getOrCreateMetrics(nodeId) };
  }

  healthService.updateFromAgentReport(nodeId, { xrayAlive, cnReachable, trafficRecords, configHash });
}

/**
 * 处理指令执行结果
 */
function handleCmdResult(ws, msg) {
  const { id, success, stdout, stderr, error, message: resultMsg, ...rest } = msg;
  const pending = pendingCommands.get(id);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingCommands.delete(id);

  if (success) {
    pending.resolve({ success: true, data: { stdout, stderr, message: resultMsg, ...rest } });
  } else {
    pending.resolve({ success: false, error: error || stderr || '执行失败' });
  }
}

/**
 * 处理 pong
 */
function handlePong(ws) {
  const { nodeId } = ws._agentState;
  const agent = agents.get(nodeId);
  if (agent) agent._pongReceived = true;
}

/**
 * 向指定节点 agent 发送指令
 * @returns {Promise<{success, data?, error?}>}
 */
function sendCommand(nodeId, command) {
  return new Promise((resolve) => {
    const agent = agents.get(nodeId);
    if (!agent || agent.ws.readyState !== 1) {
      return resolve({ success: false, error: 'Agent 不在线' });
    }

    const id = uuidv4();
    const payload = { ...command, id };

    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      resolve({ success: false, error: '指令超时' });
    }, CMD_TIMEOUT);

    pendingCommands.set(id, { resolve, timer, nodeId });

    try {
      agent.ws.send(JSON.stringify(payload));
    } catch (err) {
      clearTimeout(timer);
      pendingCommands.delete(id);
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * 获取所有在线 agent 信息
 */
function getConnectedAgents() {
  const result = [];
  for (const [nodeId, agent] of agents) {
    if (agent.ws.readyState !== 1) continue;
    result.push({
      nodeId,
      nodeName: agent.nodeName,
      ip: agent.ip,
      connectedAt: agent.connectedAt,
      lastReport: agent.lastReport,
      reportData: agent.reportData,
      version: agent.version || null,
      capabilities: agent.capabilities || null,
      reconnectMetrics: agent.reconnectMetrics || { ...getOrCreateMetrics(nodeId) },
    });
  }
  return result;
}

/**
 * 检查指定节点是否有 agent 在线
 */
function isAgentOnline(nodeId) {
  const agent = agents.get(nodeId);
  return agent && agent.ws.readyState === 1;
}

/**
 * 获取指定节点 agent 的最新上报数据
 */
function getAgentReport(nodeId) {
  const agent = agents.get(nodeId);
  if (!agent || agent.ws.readyState !== 1) return null;
  return agent.reportData;
}

/**
 * 关闭 WebSocket 服务
 */
function shutdown() {
  if (pingTimer) clearInterval(pingTimer);
  for (const [, agent] of agents) {
    try { agent.ws.close(1001, '服务关闭'); } catch {}
  }
  agents.clear();
  for (const [, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    try { pending.resolve({ success: false, error: '服务关闭' }); } catch {}
  }
  pendingCommands.clear();
  if (wss) wss.close();
}

module.exports = {
  init,
  sendCommand,
  getConnectedAgents,
  isAgentOnline,
  getAgentReport,
  shutdown,
};
