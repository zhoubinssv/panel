const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { randomPort } = require('../utils/vless');
const { syncAllNodesConfig } = require('./deploy');
const { notify } = require('./notify');

// 核心轮换：端口 + UUID + 同步配置（手动/自动共用）
async function rotateCore() {
  const nodes = db.getAllNodes(true);
  console.log(`[轮换开始] 共 ${nodes.length} 个活跃节点`);

  for (const node of nodes) {
    const portMin = parseInt(db.getSetting('rotate_port_min')) || 10000;
    const portMax = parseInt(db.getSetting('rotate_port_max')) || 60000;
    db.updateNodeAfterRotation(node.id, node.uuid, randomPort(portMin, portMax));
  }

  const uuidCount = db.rotateAllUserNodeUuids();
  console.log(`[轮换] 已重置 ${uuidCount} 个用户-节点 UUID`);

  const { success, failed } = await syncAllNodesConfig(db);
  return { success, failed, uuidCount };
}

// 自动轮换（cron 调用）：核心 + 7天一次 token 轮换
async function rotateAll() {
  const core = await rotateCore();

  // 每7天重置订阅 token
  const lastTokenRotate = db.getSetting('last_token_rotate') || '2000-01-01';
  const daysSince = Math.floor((Date.now() - new Date(lastTokenRotate).getTime()) / 86400000);
  let tokenCount = 0;
  if (daysSince >= 7) {
    const users = db.getAllUsers();
    for (const user of users) { db.resetSubToken(user.id); }
    tokenCount = users.length;
    db.setSetting('last_token_rotate', new Date().toISOString().slice(0, 10));
    console.log(`[轮换] 已重置 ${tokenCount} 个用户订阅 token（每7天）`);
  } else {
    console.log(`[轮换] 订阅 token 跳过（距上次 ${daysSince} 天，7天一换）`);
  }

  const result = { ...core, tokenCount };
  console.log(`[轮换完成] 同步 ✅${core.success} ❌${core.failed} | UUID:${core.uuidCount} | 订阅:${tokenCount}`);
  db.addAuditLog(null, 'auto_rotate', `自动轮换完成 同步✅${core.success} ❌${core.failed} UUID:${core.uuidCount} 订阅:${tokenCount}`, 'system');
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
