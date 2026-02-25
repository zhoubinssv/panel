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
