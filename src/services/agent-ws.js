/**
 * WebSocket Agent 服务
 * 管理节点 agent 的 WebSocket 连接，接收上报数据，下发指令
 */
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
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
    return ws.close(4005, '捐赠节点功能已下线');
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
