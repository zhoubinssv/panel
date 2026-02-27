const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { randomPort } = require('../utils/vless');
const { syncNodeConfig } = require('./deploy');
const { notify } = require('./notify');

// 核心轮换：端口 + UUID + 同步配置（排除手动节点）
async function rotateCore() {
  const allActiveNodes = db.getAllNodes(true);
  const nodes = allActiveNodes.filter(n => !n.is_manual);
  console.log(`[轮换开始] 活跃节点 ${allActiveNodes.length} 个，其中参与轮换 ${nodes.length} 个（已排除手动节点）`);

  for (const node of nodes) {
    if (node.rotate_port_locked) {
      db.updateNode(node.id, { last_rotated: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') });
      continue;
    }
    const portMin = parseInt(db.getSetting('rotate_port_min')) || 10000;
    const portMax = parseInt(db.getSetting('rotate_port_max')) || 60000;
    db.updateNodeAfterRotation(node.id, node.uuid, randomPort(portMin, portMax));
  }

  const uuidCount = db.rotateUserNodeUuidsByNodeIds(nodes.map(n => n.id));
  console.log(`[轮换] 已重置 ${uuidCount} 个用户-节点 UUID（自动节点）`);

  let success = 0, failed = 0;
  const CONCURRENCY = 5;
  const queue = [...nodes];

  async function worker() {
    while (queue.length) {
      const node = queue.shift();
      if (!node) break;
      const updatedNode = db.getNodeById(node.id);
      const ok = await syncNodeConfig(updatedNode, db).catch(() => false);
      if (ok) success++; else failed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, nodes.length || 1) }, () => worker()));
  return { success, failed, uuidCount };
}

/**
 * 获取用户订阅重置间隔天数
 * 0-1级: 7天
 * 2级: 15天
 * 3级/捐赠者: 月底重置（返回 'monthly'）
 * 4级: 不重置（返回 Infinity）
 */
function getResetInterval(user) {
  if (user.trust_level >= 4) return Infinity;
  if (user.trust_level >= 3 || user.is_donor) return 'monthly';
  if (user.trust_level >= 2) return 15;
  return 7;
}

/**
 * 检查是否需要重置该用户的订阅 token
 */
function shouldResetToken(user, today) {
  const interval = getResetInterval(user);
  if (interval === Infinity) return false;

  const lastReset = user.last_token_reset || '2000-01-01';

  if (interval === 'monthly') {
    // 月底重置：当前日期是新月份的第一天，且上次重置不是本月
    const todayDate = new Date(today + 'T00:00:00+08:00');
    const lastDate = new Date(lastReset + 'T00:00:00+08:00');
    // 判断是否跨月了
    return todayDate.getFullYear() > lastDate.getFullYear() ||
           todayDate.getMonth() > lastDate.getMonth();
  }

  // 按天数间隔
  const daysSince = Math.floor((new Date(today).getTime() - new Date(lastReset).getTime()) / 86400000);
  return daysSince >= interval;
}

// 自动轮换（cron 调用）：核心 + 分级 token 轮换
async function rotateAll() {
  const core = await rotateCore();

  // 分级订阅 token 重置
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const users = db.getUsersForTokenRotation();
  let tokenCount = 0;
  const resetDetails = { lv01: 0, lv2: 0, lv3donor: 0, lv4skip: 0 };

  for (const user of users) {
    if (shouldResetToken(user, today)) {
      db.resetSubToken(user.id);
      db.getDb().prepare("UPDATE users SET last_token_reset = ? WHERE id = ?").run(today, user.id);
      tokenCount++;
      const interval = getResetInterval(user);
      if (interval === 7) resetDetails.lv01++;
      else if (interval === 15) resetDetails.lv2++;
      else if (interval === 'monthly') resetDetails.lv3donor++;
    } else if (getResetInterval(user) === Infinity) {
      resetDetails.lv4skip++;
    }
  }

  console.log(`[轮换] 订阅token重置 ${tokenCount} 个 (Lv0-1:${resetDetails.lv01} Lv2:${resetDetails.lv2} Lv3/捐赠:${resetDetails.lv3donor} Lv4免重置:${resetDetails.lv4skip})`);

  const result = { ...core, tokenCount };
  console.log(`[轮换完成] 同步 ✅${core.success} ❌${core.failed} | UUID:${core.uuidCount} | 订阅:${tokenCount}`);
  db.addAuditLog(null, 'auto_rotate', `自动轮换完成 同步✅${core.success} ❌${core.failed} UUID:${core.uuidCount} 订阅:${tokenCount} (Lv0-1:${resetDetails.lv01} Lv2:${resetDetails.lv2} Lv3/捐赠:${resetDetails.lv3donor} Lv4免:${resetDetails.lv4skip})`, 'system');
  notify.rotate(result);
  return result;
}

// 手动轮换：只换端口+UUID，不换 token
async function rotateManual() {
  const core = await rotateCore();
  const result = { ...core, tokenCount: 0 };
  console.log(`[手动轮换] 同步 ✅${core.success} ❌${core.failed} | UUID:${core.uuidCount}`);
  db.addAuditLog(null, 'manual_rotate', `手动轮换完成 同步✅${core.success} ❌${core.failed} UUID:${core.uuidCount}`, 'system');
  notify.rotate(result);
  return result;
}

module.exports = { rotateAll, rotateManual };
