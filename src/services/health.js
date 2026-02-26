const net = require('net');
const db = require('./database');
const { notify, send: notifySend } = require('./notify');

// 模块级缓存（替代 global 变量）
const _trafficNotifiedCache = new Set();
// 节点连续失败计数（防抖用，连续 N 次失败才通知掉线）
const _nodeFailCount = new Map();

// TCP 端口探测
function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    socket.setTimeout(timeout);
    socket.on('connect', () => { resolved = true; socket.destroy(); resolve(true); });
    socket.on('timeout', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.on('error', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.connect(port, host);
  });
}

// 在线用户共享缓存
const _onlineCache = { full: null, summary: null, ts: 0 };
function getOnlineCache() { return _onlineCache; }

// 保存流量记录到数据库
function saveTrafficRecords(nodeId, records) {
  if (!records || records.length === 0) return 0;
  const userTraffic = {};
  for (const r of records) {
    if (!userTraffic[r.userId]) userTraffic[r.userId] = { up: 0, down: 0 };
    if (r.direction === 'uplink') userTraffic[r.userId].up += r.value;
    else userTraffic[r.userId].down += r.value;
  }
  let count = 0;
  for (const [userId, traffic] of Object.entries(userTraffic)) {
    if (traffic.up > 0 || traffic.down > 0) {
      db.recordTraffic(parseInt(userId), nodeId, traffic.up, traffic.down);
      count++;
    }
  }
  return count;
}

// 流量超标检测（10GB/天）
function checkTrafficExceed() {
  try {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // Asia/Shanghai
    const todayTraffic = db.getDb().prepare(`
      SELECT t.user_id, u.username, SUM(t.uplink) as total_up, SUM(t.downlink) as total_down
      FROM traffic_daily t JOIN users u ON t.user_id = u.id
      WHERE t.date = ? GROUP BY t.user_id HAVING (total_up + total_down) >= ?
    `).all(today, 10 * 1073741824);
    for (const u of todayTraffic) {
      const cacheKey = `traffic_notified_${u.user_id}_${today}`;
      if (!_trafficNotifiedCache.has(cacheKey)) {
        _trafficNotifiedCache.add(cacheKey);
        const gb = ((u.total_up + u.total_down) / 1073741824).toFixed(2);
        db.addAuditLog(null, 'traffic_exceed', `用户 ${u.username} 今日流量超标: ${gb} GB`, 'system');
        notify.trafficExceed(u.username, u.total_up + u.total_down);
      }
    }
  } catch (e) {
    console.error('[流量超标检测]', e.message);
  }
}

// 更新在线用户缓存（从流量记录推断）
function updateOnlineCache(nodeId, trafficRecords) {
  if (!trafficRecords || trafficRecords.length === 0) return;
  const now = Date.now();
  // 仅在缓存不存在或过期时重建
  if (!_onlineCache.full || now - _onlineCache.ts > 120000) {
    _onlineCache.full = { total: 0, users: [], nodes: [] };
    _onlineCache.ts = now;
  }
  const cache = _onlineCache.full;
  const node = db.getNodeById(nodeId);
  if (!node) return;

  const nodeUserIds = new Set();
  for (const r of trafficRecords) {
    nodeUserIds.add(r.userId);
  }

  // 更新节点在线信息
  const existIdx = cache.nodes.findIndex(n => n.nodeId === nodeId);
  if (existIdx >= 0) cache.nodes[existIdx].count = nodeUserIds.size;
  else cache.nodes.push({ nodeId, nodeName: node.name, count: nodeUserIds.size });

  // 合并用户列表（去重）
  const existingIds = new Set(cache.users.map(u => u.id));
  for (const uid of nodeUserIds) {
    if (!existingIds.has(uid)) {
      const u = db.getUserById(uid);
      if (u) cache.users.push({ id: u.id, username: u.username });
    }
  }
  cache.total = cache.users.length;
  _onlineCache.summary = { online: cache.total, nodes: cache.nodes.length };
  _onlineCache.ts = now;
}

/**
 * 统一处理 Agent 上报数据
 * 供 agent-ws.js 调用，集中所有节点状态更新、流量保存、通知等逻辑
 */
function updateFromAgentReport(nodeId, reportData) {
  const { xrayAlive, cnReachable, trafficRecords } = reportData;
  const now = new Date(Date.now() + 8 * 3600000).toISOString();
  const node = db.getNodeById(nodeId);
  if (!node) return;

  // 判定节点状态
  let status, remark;
  if (!xrayAlive) {
    status = 0;
    remark = '🔴 Xray 离线 (Agent)';
  } else if (cnReachable === false) {
    status = 0;
    remark = '🧱 疑似被墙 (Agent)';
  } else {
    status = 1;
    remark = '';
  }

  // 防抖：连续失败计数，达到阈值才通知掉线
  const FAIL_THRESHOLD = 3;
  const prevFailCount = _nodeFailCount.get(nodeId) || 0;

  if (status === 0) {
    // 失败计数 +1
    const newFailCount = prevFailCount + 1;
    _nodeFailCount.set(nodeId, newFailCount);

    if (newFailCount === FAIL_THRESHOLD) {
      // 达到阈值，触发掉线通知
      console.log(`[Agent] 节点 ${node.name} 连续 ${FAIL_THRESHOLD} 次失败 → ${remark}`);
      db.addAuditLog(null, remark.includes('被墙') ? 'node_blocked' : 'node_xray_down', `${node.name}: ${remark}（连续${FAIL_THRESHOLD}次）`, 'system');

      // 被墙且绑 AWS：自动换 IP
      if (remark.includes('被墙') && node.aws_instance_id) {
        notify.nodeBlocked(node.name, '自动换 IP');
        (async () => {
          try {
            db.addAuditLog(null, 'auto_swap_ip_start', `被墙自动换 IP: ${node.name}`, 'system');
            notify.ops(`🧱 <b>Agent 检测到疑似被墙</b>\n节点: ${node.name}\n动作: 自动换 IP`);
            const aws = require('./aws'); // 延迟加载避免循环依赖
            const swap = await aws.swapNodeIp(node, node.aws_instance_id, node.aws_type, node.aws_region, node.aws_account_id);
            if (swap.success) {
              db.addAuditLog(null, 'auto_swap_ip_ok', `${node.name} 换 IP 成功: ${swap.oldIp || '?'} → ${swap.newIp}`, 'system');
              notify.ops(`✅ <b>自动换 IP 成功</b>\n节点: ${node.name}\nIP: ${swap.oldIp || '未知'} → ${swap.newIp}`);
            } else {
              db.addAuditLog(null, 'auto_swap_ip_fail', `${node.name} 换 IP 失败: ${swap.error}`, 'system');
              notify.ops(`❌ <b>自动换 IP 失败</b>\n节点: ${node.name}\n原因: ${swap.error}`);
            }
          } catch (e) {
            db.addAuditLog(null, 'auto_swap_ip_fail', `${node.name} 换 IP 异常: ${e.message}`, 'system');
            notify.ops(`❌ <b>自动换 IP 异常</b>\n节点: ${node.name}\n原因: ${e.message}`);
          }
        })();
      } else if (remark.includes('被墙')) {
        notify.nodeBlocked(node.name, '需手动处理');
      } else {
        notify.nodeDown(node.name + ' ' + remark);
      }
    } else if (newFailCount < FAIL_THRESHOLD) {
      // 未达阈值，静默，不更新数据库状态
      console.log(`[Agent] 节点 ${node.name} 检测失败 (${newFailCount}/${FAIL_THRESHOLD})，暂不通知`);
      // 保存 agent 上报时间但不改状态
      try { db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?').run(now, nodeId); } catch {}
      // 保存流量 & 检测超标
      if (trafficRecords && trafficRecords.length > 0) {
        saveTrafficRecords(nodeId, trafficRecords);
        updateOnlineCache(nodeId, trafficRecords);
      }
      checkTrafficExceed();
      return; // 提前返回，不更新节点为离线
    }
    // newFailCount > FAIL_THRESHOLD: 已经通知过了，静默更新状态即可
  } else {
    // 恢复在线：清零计数
    if (prevFailCount >= FAIL_THRESHOLD && !node.is_active) {
      // 之前确实判定过掉线，现在恢复
      console.log(`[Agent] 节点 ${node.name} 恢复在线 🟢`);
      db.addAuditLog(null, 'node_recovered', `${node.name} 恢复在线`, 'system');
      notify.nodeUp(node.name);
    }
    _nodeFailCount.set(nodeId, 0);
  }

  // 更新节点状态
  db.updateNode(nodeId, {
    is_active: status,
    remark,
    last_check: now.replace('T', ' ').substring(0, 19),
  });

  // 保存 agent 上报时间
  try {
    db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?').run(now, nodeId);
  } catch {}

  // 手动节点：连续失败自动移除
  if (node.is_manual) {
    const nextFailCount = status === 0 ? ((node.fail_count || 0) + 1) : 0;
    db.updateNode(nodeId, { fail_count: nextFailCount });
    if (status === 0 && nextFailCount >= 3) {
      const detail = `${node.name} (${node.host}:${node.port}) 连续 ${nextFailCount} 次检测失败，已自动移除`;
      console.log(`[Agent] [手动节点自动移除] ${detail}`);
      db.addAuditLog(null, 'node_auto_remove_manual', detail, 'system');
      db.deleteNode(nodeId);
      // notify already imported at top
      send(`🗑️ <b>手动节点已自动移除</b>\n节点: ${node.name}\n地址: ${node.host}:${node.port}\n原因: 连续 ${nextFailCount} 次检测失败 (${remark})\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
      return;
    }
  }

  // 保存流量记录
  if (trafficRecords && trafficRecords.length > 0) {
    saveTrafficRecords(nodeId, trafficRecords);
    // 更新在线用户缓存
    updateOnlineCache(nodeId, trafficRecords);
  }

  // 流量超标检测
  checkTrafficExceed();
}

module.exports = { checkPort, getOnlineCache, updateFromAgentReport };
