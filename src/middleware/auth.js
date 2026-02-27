const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');
const db = require('../services/database');
const { emitSyncAll } = require('../services/configEvents');

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
          // 注册白名单用户可以突破限制
          if (!db.isInRegisterWhitelist(userInfo.username)) {
            return done(null, false, { message: '注册已满，暂不接受新用户' });
          }
        }
      }

      // 创建或更新用户
      const user = db.findOrCreateUser(userInfo);
      if (user.is_blocked) {
        return done(null, false, { message: '账号已被封禁' });
      }

      // 仅在新用户注册或用户解冻时同步节点配置，避免每次登录都触发全量同步
      if (!existing || user._wasFrozen) {
        emitSyncAll();
      }

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
// 用户活跃时间更新缓存（节流5分钟，避免频繁写库）
const _lastActiveCache = new Map();

function requireAuth(req, res, next) {
  if (req.isAuthenticated() && !req.user.is_blocked) {
    // 更新最后活跃时间（每5分钟最多写一次）
    const userId = req.user.id;
    const now = Date.now();
    const last = _lastActiveCache.get(userId) || 0;
    if (now - last > 5 * 60 * 1000) {
      _lastActiveCache.set(userId, now);
      try {
        const db = require('../services/database');
        db.getDb().prepare("UPDATE users SET last_login = datetime('now', 'localtime') WHERE id = ?").run(userId);
      } catch {}
    }
    return next();
  }
  res.redirect('/auth/login');
}

// 管理员检查中间件
function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.is_admin) return next();
  res.status(403).json({ error: '需要管理员权限' });
}

module.exports = { setupAuth, requireAuth, requireAdmin };
