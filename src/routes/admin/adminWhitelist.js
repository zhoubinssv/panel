const express = require('express');
const db = require('../../services/database');
const { emitSyncAll } = require('../../services/configEvents');

const router = express.Router();

router.post('/whitelist/add', (req, res) => {
  const { username } = req.body;
  const user = username && db.getAllUsers().find(u => u.username === username.trim());
  if (user) {
    db.addToWhitelist(user.nodeloc_id);
    db.addAuditLog(req.user.id, 'whitelist_add', `添加白名单: ${user.username}`, req.ip);
    emitSyncAll();
  }
  res.redirect('/admin#whitelist');
});

router.post('/whitelist/remove', (req, res) => {
  const { nodeloc_id } = req.body;
  if (nodeloc_id) {
    db.removeFromWhitelist(parseInt(nodeloc_id));
    db.addAuditLog(req.user.id, 'whitelist_remove', `移除白名单: ID#${nodeloc_id}`, req.ip);
    emitSyncAll();
  }
  res.redirect('/admin#whitelist');
});

router.post('/register-whitelist/add', (req, res) => {
  const username = (req.body.username || '').trim();
  if (username) {
    db.addToRegisterWhitelist(username);
    db.addAuditLog(req.user.id, 'reg_whitelist_add', `添加注册白名单: ${username}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

router.post('/register-whitelist/remove', (req, res) => {
  const username = (req.body.username || '').trim();
  if (username) {
    db.removeFromRegisterWhitelist(username);
    db.addAuditLog(req.user.id, 'reg_whitelist_remove', `移除注册白名单: ${username}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

// Telegram 登录白名单
router.post('/tg-whitelist/add', (req, res) => {
  const telegramId = (req.body.telegram_id || '').trim();
  const username = (req.body.username || '').trim();
  if (telegramId) {
    db.getDb().prepare('INSERT OR IGNORE INTO tg_login_whitelist (telegram_id, username) VALUES (?, ?)').run(telegramId, username || null);
    db.addAuditLog(req.user.id, 'tg_whitelist_add', `添加 TG 登录白名单: ${username || telegramId}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

router.post('/tg-whitelist/remove', (req, res) => {
  const telegramId = (req.body.telegram_id || '').trim();
  if (telegramId) {
    db.getDb().prepare('DELETE FROM tg_login_whitelist WHERE telegram_id = ?').run(telegramId);
    db.addAuditLog(req.user.id, 'tg_whitelist_remove', `移除 TG 登录白名单: ${telegramId}`, req.ip);
  }
  res.redirect('/admin#whitelist');
});

module.exports = router;
