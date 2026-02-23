const express = require('express');
const db = require('../services/database');
const { formatBytes } = require('../services/traffic');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const tgEvents = {};
  ['tg_on_login','tg_on_node_down','tg_on_rotate','tg_on_admin','tg_on_abuse','tg_on_traffic'].forEach(k => {
    tgEvents[k] = db.getSetting(k) === 'true';
  });
  res.render('admin', {
    users: db.getAllUsers(),
    nodes: db.getAllNodes(),
    whitelist: db.getWhitelist(),
    logs: db.getAuditLogs(50, 0),
    globalTraffic: db.getGlobalTraffic(),
    usersTraffic: db.getAllUsersTraffic(new Date().toISOString().slice(0,10)),
    aiProviders: db.getAllAiProviders(),
    formatBytes,
    tgBotToken: db.getSetting('tg_bot_token') || '',
    tgChatId: db.getSetting('tg_chat_id') || '',
    tgEvents,
    announcement: db.getSetting('announcement') || ''
  });
});

module.exports = router;
