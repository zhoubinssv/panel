const express = require('express');
const db = require('../../services/database');
const { emitSyncAll } = require('../../services/configEvents');
const { parseIntId } = require('../../utils/parseIntId');

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
  const sortBy = req.query.sortBy || 'total_traffic';
  const sortDir = req.query.sortDir || 'DESC';
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getAllUsersPaged(limit, offset, search, sortBy, sortDir);
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

// 用户综合详情（流量排行点击查看）
router.get('/users/:id/detail', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 基本信息
  const info = {
    id: user.id, username: user.username, name: user.name,
    trust_level: user.trust_level, is_admin: user.is_admin,
    is_blocked: user.is_blocked, is_frozen: user.is_frozen,
    last_login: user.last_login, created_at: user.created_at,
    expires_at: user.expires_at, traffic_limit: user.traffic_limit,
    nodeloc_id: user.nodeloc_id, sub_token: user.sub_token,
  };

  // 流量统计
  const d = db.getDb();
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const todayTraffic = d.prepare('SELECT COALESCE(SUM(uplink),0) as up, COALESCE(SUM(downlink),0) as down FROM traffic_daily WHERE user_id = ? AND date = ?').get(id, today);
  const totalTraffic = d.prepare('SELECT COALESCE(SUM(uplink),0) as up, COALESCE(SUM(downlink),0) as down FROM traffic_daily WHERE user_id = ?').get(id);

  // 订阅拉取记录（最近24h）
  const subAccess = db.getSubAccessUserDetail(id, 24);

  // 最近7天流量趋势
  const weekAgo = new Date(Date.now() - 6 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const dailyTraffic = d.prepare('SELECT date, COALESCE(SUM(uplink),0) as up, COALESCE(SUM(downlink),0) as down FROM traffic_daily WHERE user_id = ? AND date >= ? GROUP BY date ORDER BY date').all(id, weekAgo);

  res.json({ info, todayTraffic, totalTraffic, subAccess, dailyTraffic });
});

module.exports = router;
