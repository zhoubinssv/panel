const express = require('express');
const crypto = require('crypto');
const passport = require('passport');
const db = require('../services/database');
const { emitSyncAll } = require('../services/configEvents');

const router = express.Router();

// 登录页
router.get('/login', (req, res) => {
  res.render('login', { error: req.query.error || '' });
});

// 发起 OAuth
router.get('/nodeloc', (req, res, next) => {
  // 生成 state 防 CSRF
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  passport.authenticate('nodeloc', { state })(req, res, next);
});

// OAuth 回调
const { notify } = require('../services/notify');

router.get('/callback', (req, res, next) => {
  passport.authenticate('nodeloc', (err, user, info) => {
    if (err) {
      console.error('OAuth 错误:', err);
      return res.redirect('/auth/login?error=' + encodeURIComponent('登录失败，请重试'));
    }
    if (!user) {
      const msg = info?.message || '登录失败';
      return res.redirect('/auth/login?error=' + encodeURIComponent(msg));
    }
    req.logIn(user, (err) => {
      if (err) return res.redirect('/auth/login?error=' + encodeURIComponent('登录失败'));
      const loginIP = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip;
      db.addAuditLog(user.id, 'login', `用户 ${user.username} 登录`, loginIP);
      // 如果用户刚被解冻，异步同步节点配置
      if (user._wasFrozen) {
        emitSyncAll();
      }
      res.redirect('/');
    });
  })(req, res, next);
});

// Telegram Login 验签 + 登录
router.get('/telegram', async (req, res) => {
  try {
    const { hash, ...params } = req.query;
    if (!hash) return res.redirect('/auth/login?error=' + encodeURIComponent('缺少验证参数'));

    // 获取 bot token
    const botToken = db.getSetting('tg_bot_token');
    if (!botToken) return res.redirect('/auth/login?error=' + encodeURIComponent('未配置 Telegram Bot'));

    // 验证 auth_date 不超过 86400 秒
    const authDate = parseInt(params.auth_date);
    if (Math.floor(Date.now() / 1000) - authDate > 86400) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('登录已过期，请重试'));
    }

    // HMAC-SHA256 验签
    const secret = crypto.createHash('sha256').update(botToken).digest();
    const dataCheckString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (hmac !== hash) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('验证失败'));
    }

    const telegramId = params.id;

    // 检查白名单
    const inWhitelist = db.getDb().prepare('SELECT 1 FROM tg_login_whitelist WHERE telegram_id = ?').get(String(telegramId));
    if (!inWhitelist) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('未授权的 Telegram 账号'));
    }

    // 查找或创建用户
    let user = db.getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(telegramId));
    if (user) {
      db.getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
      user = db.getUserById(user.id);
    } else {
      const subToken = crypto.randomBytes(16).toString('hex');
      const username = params.username || params.first_name || `tg_${telegramId}`;
      const avatarUrl = params.photo_url || null;
      const negId = -Math.abs(Number(telegramId));
      const defaultLimit = parseInt(db.getSetting('default_traffic_limit')) || 0;

      db.getDb().prepare(`
        INSERT INTO users (nodeloc_id, telegram_id, username, name, avatar_url, trust_level, sub_token, is_admin, traffic_limit, last_login)
        VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, datetime('now'))
      `).run(negId, Number(telegramId), username, params.first_name || username, avatarUrl, subToken, defaultLimit);

      user = db.getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(telegramId));
      db.ensureUserHasAllNodeUuids(user.id);
      db.addAuditLog(null, 'user_register', `Telegram 用户注册: ${username}`, 'system');
      try { const { notify } = require('../services/notify'); notify.userRegister(username); } catch {}
      emitSyncAll();
    }

    if (user.is_blocked) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('账号已被封禁'));
    }

    req.logIn(user, (err) => {
      if (err) return res.redirect('/auth/login?error=' + encodeURIComponent('登录失败'));
      const loginIP = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip;
      db.addAuditLog(user.id, 'login', `Telegram 用户 ${user.username} 登录`, loginIP);
      if (user.is_frozen) {
        db.getDb().prepare('UPDATE users SET is_frozen = 0 WHERE id = ?').run(user.id);
        db.ensureUserHasAllNodeUuids(user.id);
        emitSyncAll();
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('Telegram 登录错误:', err);
    res.redirect('/auth/login?error=' + encodeURIComponent('登录失败，请重试'));
  }
});

// 登出
router.get('/logout', (req, res) => {
  if (req.user) {
    db.addAuditLog(req.user.id, 'logout', `用户 ${req.user.username} 登出`, req.ip);
  }
  req.logout(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
