const db = require('./database');

function getConfig() {
  const token = db.getSetting('tg_bot_token');
  const chatId = db.getSetting('tg_chat_id');
  return (token && chatId) ? { token, chatId } : null;
}

async function send(text) {
  const cfg = getConfig();
  if (!cfg) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[TG]', e.message); }
}

// 通知类型
const notify = {
  nodeDown(nodeName) {
    if (db.getSetting('tg_on_node_down') !== 'true') return;
    send(`🔴 <b>节点离线</b>\n节点: ${nodeName}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  nodeUp(nodeName) {
    if (db.getSetting('tg_on_node_down') !== 'true') return;
    send(`🟢 <b>节点恢复</b>\n节点: ${nodeName}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  nodeBlocked(nodeName, action) {
    if (db.getSetting('tg_on_node_blocked') !== 'true') return;
    send(`🧱 <b>节点疑似被墙</b>\n节点: ${nodeName}\n动作: ${action || '等待处理'}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  rotate(result) {
    if (db.getSetting('tg_on_rotate') !== 'true') return;
    send(`🔄 <b>自动轮换完成</b>\n节点同步: ✅${result.success} ❌${result.failed}\nUUID重置: ${result.uuidCount}\n订阅重置: ${result.tokenCount}`).catch(() => {});
  },
  abuse(username, ipCount) {
    if (db.getSetting('tg_on_abuse') !== 'true') return;
    send(`⚠️ <b>订阅异常</b>\n用户: ${username}\n${ipCount} 个不同 IP 拉取订阅`).catch(() => {});
  },
  trafficExceed(username, bytes) {
    if (db.getSetting('tg_on_traffic') !== 'true') return;
    const gb = (bytes / 1073741824).toFixed(2);
    send(`📊 <b>流量超标</b>\n用户: ${username}\n今日已用: ${gb} GB`).catch(() => {});
  },
  userRegister(username, profile) {
    if (db.getSetting('tg_on_register') !== 'true') return;
    const total = db.getUserCount();
    const lvNames = { 0: '新手', 1: '基础', 2: '活跃', 3: '资深', 4: '领袖' };
    const lv = profile?.trust_level ?? 0;
    let msg = `👤 <b>新用户注册</b>\n`;
    msg += `用户名: ${username}\n`;
    if (profile?.name && profile.name !== username) msg += `昵称: ${profile.name}\n`;
    msg += `等级: Lv${lv} ${lvNames[lv] || ''}\n`;
    msg += `总用户: ${total}\n`;
    msg += `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    send(msg).catch(() => {});
  },
  deploy(nodeName, success, detail) {
    if (db.getSetting('tg_on_deploy') !== 'true') return;
    send(`${success ? '✅' : '❌'} <b>节点部署${success ? '成功' : '失败'}</b>\n节点: ${nodeName}\n${detail || ''}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  ops(msg) {
    if (db.getSetting('tg_on_ops') !== 'true') return;
    send(msg).catch(() => {});
  }
};

module.exports = { send, notify };
