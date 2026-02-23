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
  login(username, ip) {
    if (db.getSetting('tg_on_login') !== 'true') return;
    send(`👤 <b>用户登录</b>\n用户: ${username}\nIP: ${ip}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  nodeDown(nodeName) {
    if (db.getSetting('tg_on_node_down') !== 'true') return;
    send(`🔴 <b>节点离线</b>\n节点: ${nodeName}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  nodeUp(nodeName) {
    if (db.getSetting('tg_on_node_down') !== 'true') return;
    send(`🟢 <b>节点恢复</b>\n节点: ${nodeName}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
  },
  rotate(result) {
    if (db.getSetting('tg_on_rotate') !== 'true') return;
    send(`🔄 <b>自动轮换完成</b>\n节点同步: ✅${result.success} ❌${result.failed}\nUUID重置: ${result.uuidCount}\n订阅重置: ${result.tokenCount}`).catch(() => {});
  },
  adminAction(username, action, detail) {
    if (db.getSetting('tg_on_admin') !== 'true') return;
    send(`⚙️ <b>管理操作</b>\n管理员: ${username}\n操作: ${action}\n${detail || ''}`).catch(() => {});
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
  ops(msg) {
    if (db.getSetting('tg_on_ops') !== 'true') return;
    send(msg).catch(() => {});
  }
};

module.exports = { send, notify };
