const express = require('express');
const db = require('../../services/database');
const { emitSyncAll } = require('../../services/configEvents');

function parseIntId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const router = express.Router();

router.post('/users/:id/toggle-block', async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
  if (user) {
    db.blockUser(user.id, !user.is_blocked);
    db.addAuditLog(req.user.id, 'user_block', `${user.is_blocked ? '解封' : '封禁'} 用户: ${user.username}`, req.ip);
    emitSyncAll();
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

router.post('/default-traffic-limit', (req, res) => {
  const limitGB = parseFloat(req.body.limit) || 0;
  const limitBytes = Math.round(limitGB * 1073741824);
  db.setSetting('default_traffic_limit', String(limitBytes));
  db.addAuditLog(req.user.id, 'default_traffic_limit', `设置默认流量限额: ${limitGB > 0 ? limitGB + ' GB' : '无限'}`, req.ip);
  res.json({ ok: true });
});

router.post('/default-traffic-limit/apply', (req, res) => {
  const limitBytes = parseInt(db.getSetting('default_traffic_limit')) || 0;
  const r = db.getDb().prepare('UPDATE users SET traffic_limit = ?').run(limitBytes);
  db.addAuditLog(req.user.id, 'default_traffic_limit_apply', `批量应用默认流量限额到全部用户: ${r.changes} 个`, req.ip);
  res.json({ ok: true, updated: r.changes });
});

router.get('/users', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = (req.query.search || '').trim();
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getAllUsersPaged(limit, offset, search);
  res.json({ ...data, page });
});

// Sprint 6: 设置用户到期时间
router.post('/users/:id/set-expiry', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const { expires_at } = req.body;
  db.setUserExpiry(user.id, expires_at || null);
  db.addAuditLog(req.user.id, 'set_expiry', `设置 ${user.username} 到期时间: ${expires_at || '永不过期'}`, req.ip);
  res.json({ ok: true });
});

module.exports = router;
