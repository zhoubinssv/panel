const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');
const db = require('../services/database');

function setupAuth(app) {
  passport.use('nodeloc', new OAuth2Strategy({
    authorizationURL: `${process.env.NODELOC_URL}/oauth-provider/authorize`,
    tokenURL: `${process.env.NODELOC_URL}/oauth-provider/token`,
    clientID: process.env.NODELOC_CLIENT_ID,
    clientSecret: process.env.NODELOC_CLIENT_SECRET,
    callbackURL: process.env.NODELOC_REDIRECT_URI,
    scope: ['openid', 'profile']
  }, async (accessToken, refreshToken, params, profile, done) => {
    try {
      // 获取用户信息
      const res = await fetch(`${process.env.NODELOC_URL}/oauth-provider/userinfo`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!res.ok) return done(new Error('获取用户信息失败'));
      const userInfo = await res.json();

      // 检查注册人数上限（已有用户直接放行，新用户才检查）
      const existing = db.getUserById(db.getDb().prepare('SELECT id FROM users WHERE nodeloc_id = ?').get(userInfo.id)?.id);
      if (!existing) {
        const maxUsers = parseInt(db.getSetting('max_users')) || 0;
        if (maxUsers > 0 && db.getUserCount() >= maxUsers) {
          return done(null, false, { message: '注册已满，暂不接受新用户' });
        }
      }

      // 创建或更新用户
      const user = db.findOrCreateUser(userInfo);
      if (user.is_blocked) {
        return done(null, false, { message: '账号已被封禁' });
      }

      // 异步同步节点配置（新用户需要把 UUID 推送到节点）
      const { syncAllNodesConfig } = require('../services/deploy');
      syncAllNodesConfig(db).catch(err => console.error('[配置同步]', err));

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    const user = db.getUserById(id);
    done(null, user || false);
  });

  app.use(passport.initialize());
  app.use(passport.session());
}

// 登录检查中间件
function requireAuth(req, res, next) {
  if (req.isAuthenticated() && !req.user.is_blocked) return next();
  res.redirect('/auth/login');
}

// 管理员检查中间件
function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.is_admin) return next();
  res.status(403).json({ error: '需要管理员权限' });
}

module.exports = { setupAuth, requireAuth, requireAdmin };
