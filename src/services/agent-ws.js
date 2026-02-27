/**
 * WebSocket Agent 服务
 * 管理节点 agent 的 WebSocket 连接，接收上报数据，下发指令
 */
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const healthService = require('./health');
const { notify } = require('./notify');

// 在线 agent 连接池：nodeId → { ws, nodeId, connectedAt, lastReport, reportData }
const agents = new Map();
// 节点连接指标：nodeId → { disconnectCount, lastDisconnectAt, lastReconnectAt, consecutiveReconnects }
const agentMetrics = new Map();

// 待响应的指令回调：cmdId → { resolve, reject, timer }
const pendingCommands = new Map();

const AUTH_TIMEOUT = 10000; // 认证超时 10s
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;
const CMD_TIMEOUT = 30000;

let wss = null;
let pingTimer = null;

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
  metrics.lastDisconnectAt = new Date(Date.now() + 8 * 3600000).toISOString();
}

/**
 * 初始化 WebSocket 服务，挂载到 HTTP server
 */
function init(server) {
  wss = new WebSocketServer({ server, path: '/ws/agent' });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    console.log(`[Agent-WS] 新连接 from ${ip}`);

    ws._agentState = { authenticated: false, nodeId: null, ip };

    // 认证超时：未认证则断开
    ws._authTimer = setTimeout(() => {
      if (!ws._agentState.authenticated) {
        console.log(`[Agent-WS] 认证超时，断开 ${ip}`);
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
        console.log(`[Agent-WS] 节点 #${nodeId} 断开连接`);
        // 延迟检测：等 30 秒看 Agent 是否重连，避免短暂抖动触发通知
        setTimeout(() => {
          if (!agents.has(nodeId)) {
            // 30 秒后仍未重连 → 真的掉了，更新状态 + 通知
            try {
              const node = db.getNodeById(nodeId);
              if (node && node.is_active) {
                db.updateNode(nodeId, {
                  is_active: 0,
                  remark: '🔴 断开',
                  last_check: new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').substring(0, 19),
                });
                db.addAuditLog(null, 'agent_offline', `节点 Agent 断开: ${node.name}`, 'system');
                notify.nodeDown(`${node.name} (Agent 断开)`);
              }
            } catch {}
          }
          // 如果已重连则什么都不做
        }, 30000);
      }
    });

    ws.on('error', (err) => {
      console.error(`[Agent-WS] 连接错误:`, err.message);
    });
  });

  // 定期 ping 检测连接活性
  pingTimer = setInterval(() => {
    for (const [nodeId, agent] of agents) {
      if (agent.ws.readyState !== 1) {
        markDisconnected(nodeId);
        agents.delete(nodeId);
        continue;
      }
      agent._pongReceived = false;
      try {
        agent.ws.send(JSON.stringify({ type: 'ping', id: uuidv4() }));
      } catch {
        markDisconnected(nodeId);
        agents.delete(nodeId);
        continue;
      }
      // 检查上次 pong
      setTimeout(() => {
        if (agents.has(nodeId) && !agents.get(nodeId)._pongReceived) {
          console.log(`[Agent-WS] 节点 #${nodeId} pong 超时，断开`);
          markDisconnected(nodeId);
          try { agent.ws.terminate(); } catch {}
          agents.delete(nodeId);
        }
      }, PONG_TIMEOUT);
    }
  }, PING_INTERVAL);

  console.log('[Agent-WS] WebSocket 服务已启动，路径: /ws/agent');
}

/**
 * 处理 agent 消息
 */
function handleMessage(ws, msg) {
  const { type } = msg;

  // 未认证只接受 auth
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
      console.log(`[Agent-WS] 未知消息类型: ${type}`);
  }
}

/**
 * 处理认证
 */
function handleAuth(ws, msg) {
  const { token, nodeId, version, capabilities } = msg;

  if (!token) {
    return ws.close(4004, '缺少 token');
  }

  // ─── 捐赠节点认证 ───
  if (token.startsWith('donate-')) {
    const d = db.getDb();
    const ip = ws._agentState.ip;
    // 先查已有的捐赠记录
    let donation = d.prepare('SELECT * FROM node_donations WHERE token = ?').get(token);
    if (!donation) {
      // 从令牌表查找用户，Agent 首次连接时才创建捐赠记录
      const tokenRecord = d.prepare('SELECT * FROM donate_tokens WHERE token = ?').get(token);
      if (!tokenRecord) {
        return ws.close(4005, '无效的捐赠令牌');
      }
      d.prepare("INSERT INTO node_donations (user_id, token, server_ip, status, protocol_choice) VALUES (?, ?, ?, 'pending', ?)").run(tokenRecord.user_id, token, ip, tokenRecord.protocol_choice || 'vless');
      donation = d.prepare('SELECT * FROM node_donations WHERE token = ?').get(token);
    } else {
      // 更新 IP，已审核通过的不改状态
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
      // 已审核通过，绑定到实际节点
      const donateNodeId = donation.node_id;
      ws._agentState.nodeId = donateNodeId;

      // 踢掉旧连接
      const oldDonate = agents.get(donateNodeId);
      if (oldDonate && oldDonate.ws !== ws) {
        try { oldDonate.ws.close(4007, '被新连接替代'); } catch {}
      }

      // 注册到 agents Map，使 sendCommand 可用
      const donateNode = db.getNodeById(donateNodeId);
      agents.set(donateNodeId, {
        ws,
        nodeId: donateNodeId,
        nodeName: donateNode ? donateNode.name : `捐赠#${donation.id}`,
        ip,
        connectedAt: new Date(Date.now() + 8 * 3600000).toISOString(),
        lastReport: null,
        reportData: null,
        version: version || null,
        capabilities: capabilities || null,
        _pongReceived: true,
      });

      ws.send(JSON.stringify({ type: 'auth_ok', message: '捐赠节点已上线' }));
      console.log(`[Agent-WS] 捐赠节点重连 node#${donateNodeId} from ${ip}`);

      // 自动修正：VLESS 捐赠节点 host 是 IPv6 时，检测 IPv4 并修正
      if (donateNode && donateNode.protocol === 'vless' && donateNode.host && donateNode.host.includes(':')) {
        setTimeout(async () => {
          try {
            const result = await sendCommand(donateNodeId, { type: 'exec', command: 'curl -4 -s --max-time 5 ifconfig.me' });
            const ipv4 = result.success && result.data?.stdout?.trim();
            if (ipv4 && /^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) {
              db.updateNode(donateNodeId, { host: ipv4 });
              console.log(`[🍑 蜜桃酱] VLESS 捐赠节点 #${donateNodeId} IPv4 修正: ${donateNode.host} → ${ipv4}`);
              // 重新同步配置
              const deploy = require('./deploy');
              const freshNode = db.getNodeById(donateNodeId);
              deploy.syncNodeConfig(freshNode, db).catch(() => {});
            }
          } catch (e) {
            console.log(`[🍑 蜜桃酱] IPv4 修正失败: ${e.message}`);
          }
        }, 3000);
      }
    } else {
      ws._agentState.nodeId = `donate-${donation.id}`;
      ws.send(JSON.stringify({ type: 'auth_ok', message: '捐赠节点已连接，蜜桃酱正在自动审核...' }));
      console.log(`[Agent-WS] 捐赠节点连接 from ${ip}, 用户#${donation.user_id}, 令牌: ${token}`);
      db.addAuditLog(donation.user_id, 'donate_connect', `捐赠节点连接: IP ${ip}`, ip);

      // 🍑 蜜桃酱自动审核：5秒后自动通过（等地区检测+IPv6检测完成）
      const protoChoice = donation.protocol_choice || tokenRecord?.protocol_choice || 'vless';

      // 注册临时Agent连接以便发命令
      const tempId = `donate-${donation.id}`;
      agents.set(tempId, { ws, nodeId: tempId, nodeName: `捐赠#${donation.id}`, ip, connectedAt: new Date(Date.now() + 8 * 3600000).toISOString(), lastReport: null, reportData: null, _pongReceived: true });

      setTimeout(async () => {
        try {
          // IPv6 检测（SS/双协议需要）
          if (protoChoice === 'ss' || protoChoice === 'dual') {
            try {
              const result = await sendCommand(tempId, { type: 'exec', command: "ip -6 addr show scope global | grep inet6 | head -1 | awk '{print $2}' | cut -d/ -f1" });
              const ipv6 = result.success && result.data?.stdout?.trim();
              if (ipv6) {
                d.prepare('UPDATE node_donations SET remark = ? WHERE id = ?').run(`IPv6: ${ipv6}`, donation.id);
                console.log(`[Agent-WS] 捐赠节点 IPv6 检测成功: ${ipv6}`);
              } else {
                const failMsg = protoChoice === 'ss' ? '❌ 未检测到 IPv6，无法部署 SS 节点' : '⚠️ 未检测到 IPv6，仅支持 VLESS';
                d.prepare('UPDATE node_donations SET remark = ? WHERE id = ?').run(failMsg, donation.id);
                console.log(`[Agent-WS] 捐赠节点 ${ip} 无 IPv6 (选择: ${protoChoice})`);
              }
            } catch (e) {
              console.error(`[Agent-WS] IPv6 检测异常:`, e.message);
            }
          }

          // 自动审核通过
          const http = require('http');
          const freshDonation = d.prepare('SELECT * FROM node_donations WHERE id = ?').get(donation.id);
          if (freshDonation && freshDonation.status === 'pending') {
            console.log(`[🍑 蜜桃酱] 自动审核捐赠节点 #${donation.id} from ${ip}`);

            // 直接调用审核逻辑（复用 adminDonations 的核心逻辑）
            const { v4: uuidv4 } = require('uuid');
            const crypto = require('crypto');
            const deploy = require('./deploy');
            const uuidRepo = require('./repos/uuidRepo');

            // 检测地区（可能已经在异步检测中完成了）
            let region = freshDonation.region || '';
            if (!region && ip) {
              try {
                const geo = await deploy.detectRegion(ip);
                if (geo && geo.cityCN !== '未知') region = `${geo.emoji} ${geo.cityCN}`;
              } catch {}
            }

            // 查捐赠者用户名
            const donor = d.prepare('SELECT username, name FROM users WHERE id = ?').get(freshDonation.user_id);
            const donorName = donor ? (donor.name || donor.username) : `用户${freshDonation.user_id}`;
            const nodeIds = [];

            // 创建 VLESS 节点（vless 或 dual）
            if (protoChoice === 'vless' || protoChoice === 'dual') {
              // 检测服务器 IPv4 地址（Agent 可能通过 IPv6 连接）
              let vlessHost = ip;
              try {
                const ipv4Result = await sendCommand(tempId, { type: 'exec', command: 'curl -4 -s --max-time 5 ifconfig.me' });
                const detectedIpv4 = ipv4Result.success && ipv4Result.data?.stdout?.trim();
                if (detectedIpv4 && /^\d+\.\d+\.\d+\.\d+$/.test(detectedIpv4)) {
                  vlessHost = detectedIpv4;
                  console.log(`[🍑 蜜桃酱] VLESS IPv4 检测: ${detectedIpv4}`);
                }
              } catch (e) {
                console.log(`[🍑 蜜桃酱] IPv4 检测失败，使用连接 IP: ${ip}`);
              }

              const nodeName = region ? `${region}-${donorName}` : donorName;
              const port = 10000 + Math.floor(Math.random() * 50000);
              const agentToken = uuidv4();
              const nodeResult = d.prepare(`
                INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, is_active, agent_token, group_name, remark, is_donation, ssh_host)
                VALUES (?, ?, ?, ?, 'vless', 4, 1, ?, '捐赠节点', '', 1, ?)
              `).run(nodeName, vlessHost, port, uuidv4(), agentToken, ip);
              const nodeId = Number(nodeResult.lastInsertRowid);
              nodeIds.push(nodeId);

              // 生成 Reality 密钥
              const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
              const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
              const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
              db.updateNode(nodeId, {
                reality_private_key: privRaw.toString('base64url'),
                reality_public_key: pubRaw.toString('base64url'),
                reality_short_id: crypto.randomBytes(4).toString('hex'),
                sni: 'www.microsoft.com'
              });
              uuidRepo.ensureAllUsersHaveUuid(nodeId);
            }

            // 创建 SS 节点（ss 或 dual，需要有 IPv6）
            if (protoChoice === 'ss' || protoChoice === 'dual') {
              const freshRemark = d.prepare('SELECT remark FROM node_donations WHERE id = ?').get(donation.id)?.remark || '';
              const ipv6Match = freshRemark.match(/IPv6:\s*(\S+)/);
              if (ipv6Match) {
                const ipv6Addr = ipv6Match[1];
                const ssName = protoChoice === 'dual'
                  ? (region ? `${region}-${donorName}⁶` : `${donorName}⁶`)
                  : (region ? `${region}-${donorName}` : donorName);
                const ssPort = 10000 + Math.floor(Math.random() * 50000);
                const ssResult = d.prepare(`
                  INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, ss_method, is_active, agent_token, group_name, remark, is_donation, ssh_host)
                  VALUES (?, ?, ?, ?, 'ss', 6, 'aes-256-gcm', 1, ?, '捐赠节点', '', 1, ?)
                `).run(ssName, ipv6Addr, ssPort, uuidv4(), uuidv4(), ip);
                const ssNodeId = Number(ssResult.lastInsertRowid);
                nodeIds.push(ssNodeId);
                uuidRepo.ensureAllUsersHaveUuid(ssNodeId);
              }
            }

            if (nodeIds.length > 0) {
              // 更新捐赠记录
              d.prepare("UPDATE node_donations SET status = 'online', node_id = ?, region = ?, approved_at = datetime('now', 'localtime') WHERE id = ?")
                .run(nodeIds[0], region, donation.id);
              d.prepare('UPDATE users SET is_donor = 1 WHERE id = ?').run(freshDonation.user_id);
              db.addAuditLog(null, 'donate_auto_approve', `🍑 蜜桃酱自动审核通过: ${ip}, 协议: ${protoChoice}, 捐赠者: ${donorName}`, 'system');

              // 绑定Agent到新节点并推送配置
              const mainNodeId = nodeIds[0];
              ws._agentState.nodeId = mainNodeId;
              const node = db.getNodeById(mainNodeId);
              agents.delete(tempId);
              agents.set(mainNodeId, { ws, nodeId: mainNodeId, nodeName: node?.name || `捐赠#${donation.id}`, ip, connectedAt: new Date(Date.now() + 8 * 3600000).toISOString(), lastReport: null, reportData: null, _pongReceived: true });

              // 推送配置
              for (const nid of nodeIds) {
                try {
                  const n = db.getNodeById(nid);
                  const ok = await deploy.syncNodeConfig(n, db);
                  console.log(`[🍑 蜜桃酱] 配置推送 ${ok ? '✅' : '❌'}: ${n.name}`);
                } catch (e) {
                  console.error(`[🍑 蜜桃酱] 配置推送异常: ${e.message}`);
                }
              }

              // TG 通知
              try {
                const { notify: _notify } = require('./notify');
                _notify.deploy && _notify.deploy(node?.name || ip, true, `🍑 蜜桃酱自动审核 | 协议: ${protoChoice} | 捐赠者: ${donorName}`);
              } catch {}

              console.log(`[🍑 蜜桃酱] 自动审核完成: ${nodeIds.length} 个节点上线`);
            }
          }
        } catch (e) {
          console.error(`[🍑 蜜桃酱] 自动审核异常:`, e.message, e.stack);
        }
      }, 5000); // 等5秒：让地区检测和IPv6检测先完成
    }
    // 异步检测地区
    try {
      const { detectRegion } = require('./deploy');
      detectRegion(ip).then(geo => {
        if (geo && geo.city !== 'Unknown') {
          const region = `${geo.emoji} ${geo.cityCN}`;
          d.prepare('UPDATE node_donations SET region = ? WHERE id = ?').run(region, donation.id);
          console.log(`[Agent-WS] 捐赠节点地区检测: ${ip} → ${region}`);
        }
      }).catch(() => {});
    } catch {}
    notify.donateConnect && notify.donateConnect(ip, donation.user_id);
    return;
  }

  // ─── 正常节点认证 ───
  if (!nodeId) {
    return ws.close(4004, '缺少 nodeId');
  }

  // 验证节点存在
  const node = db.getNodeById(nodeId);
  if (!node) {
    return ws.close(4006, '节点不存在');
  }

  // 优先检查节点独立 token，回退到全局 token（兼容旧 agent）
  const nodeToken = node.agent_token;
  const globalToken = db.getSetting('agent_token');
  if (token !== nodeToken && token !== globalToken) {
    console.log(`[Agent-WS] 节点 #${nodeId} 认证失败：token 不匹配`);
    return ws.close(4005, '认证失败');
  }

  // 踢掉旧连接
  const old = agents.get(nodeId);
  if (old && old.ws !== ws) {
    try { old.ws.close(4007, '被新连接替代'); } catch {}
  }

  clearTimeout(ws._authTimer);
  ws._agentState.authenticated = true;
  ws._agentState.nodeId = nodeId;

  const metrics = getOrCreateMetrics(nodeId);
  if (metrics.consecutiveReconnects > 0) {
    metrics.lastReconnectAt = new Date(Date.now() + 8 * 3600000).toISOString();
    metrics.consecutiveReconnects = 0;
  }

  agents.set(nodeId, {
    ws,
    nodeId,
    nodeName: node.name,
    ip: ws._agentState.ip,
    connectedAt: new Date(Date.now() + 8 * 3600000).toISOString(),
    lastReport: null,
    reportData: null,
    version: version || null,
    capabilities: capabilities || null,
    reconnectMetrics: { ...metrics },
    _pongReceived: true,
  });

  ws.send(JSON.stringify({ type: 'auth_ok' }));
  console.log(`[Agent-WS] 节点 #${nodeId} (${node.name}) 认证成功`);

  // 记录系统日志（Agent 上线不再单独发 TG 通知，由 report 上报恢复时通知）
  db.addAuditLog(null, 'agent_online', `节点 Agent 上线: ${node.name} (${ws._agentState.ip})`, 'system');
}

/**
 * 处理 agent 上报数据
 */
function handleReport(ws, msg) {
  const { nodeId } = ws._agentState;
  const agent = agents.get(nodeId);
  if (!agent) return;

  const { xrayAlive, cnReachable, loadAvg, memUsage, diskUsage, trafficRecords, version, capabilities, reconnectMetrics, configHash } = msg;
  const now = new Date(Date.now() + 8 * 3600000).toISOString();

  // 更新 agent 连接池中的上报数据（供 getAgentReport 查询）
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

  // 委托 health.js 统一处理状态更新、流量保存、通知等
  healthService.updateFromAgentReport(nodeId, { xrayAlive, cnReachable, trafficRecords, configHash });
}

/**
 * 处理指令执行结果
 */
function handleCmdResult(ws, msg) {
  const { id, cmdType, success, stdout, stderr, error, message: resultMsg, ...rest } = msg;
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
  return new Promise((resolve, reject) => {
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

    pendingCommands.set(id, { resolve, reject, timer });

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
