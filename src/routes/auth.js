const express = require('express');
const crypto = require('crypto');
const passport = require('passport');
const db = require('../services/database');
const { emitSyncAll } = require('../services/configEvents');

const router = express.Router();

// 临时登录状态（进程内）
const tempLoginState = {
  used: false,
  failCount: 0,
};

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

function safeTokenEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

// 临时登录通道（仅用于应急审查）
// 用法：/auth/temp-login?token=xxxx
// 需要环境变量：TEMP_LOGIN_ENABLED=true + TEMP_LOGIN_TOKEN=xxxx
// 可选过期时间：TEMP_LOGIN_EXPIRES_AT=毫秒时间戳
// 安全策略：最多失败5次；成功一次后立即失效（一次性）
router.get('/temp-login', (req, res) => {
  if (process.env.TEMP_LOGIN_ENABLED !== 'true') {
    return res.status(404).send('Not Found');
  }

  const expected = process.env.TEMP_LOGIN_TOKEN || '';
  const token = req.query.token || '';
  const expiresAt = parseInt(process.env.TEMP_LOGIN_EXPIRES_AT || '0', 10);

  if (!expected) {
    return res.status(403).send('临时登录未配置 token');
  }
  if (expiresAt > 0 && Date.now() > expiresAt) {
    return res.status(403).send('临时登录已过期');
  }
  if (tempLoginState.used) {
    return res.status(403).send('临时登录口令已使用');
  }
  if (tempLoginState.failCount >= 5) {
    return res.status(429).send('临时登录尝试次数过多');
  }
  if (!safeTokenEqual(token, expected)) {
    tempLoginState.failCount += 1;
    return res.status(403).send('token 无效');
  }

  const row = db.getDb().prepare('SELECT id FROM users WHERE is_admin = 1 AND is_blocked = 0 ORDER BY id ASC LIMIT 1').get();
  if (!row) {
    return res.status(500).send('未找到可用管理员账号');
  }

  const user = db.getUserById(row.id);
  if (!user) {
    return res.status(500).send('管理员账号加载失败');
  }

  req.logIn(user, (err) => {
    if (err) return res.status(500).send('登录失败');
    tempLoginState.used = true;
    const loginIP = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip;
    db.addAuditLog(user.id, 'temp_login', `临时通道登录 ${user.username}（一次性口令）`, loginIP);
    res.redirect('/admin');
  });
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
