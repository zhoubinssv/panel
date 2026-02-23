const rateLimit = require('express-rate-limit');

// 登录限流：每 IP 15 分钟最多 10 次
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录请求过于频繁，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

// AI 接口限流：每用户每分钟 10 次
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.user?.id || 'anon'),
  message: { error: 'AI 请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false }
});

// 订阅拉取限流：每 IP 每分钟 5 次
const subLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip,
  standardHeaders: true,
  legacyHeaders: false
});

// 管理 API 限流：每 IP 每分钟 60 次
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: '请求过于频繁' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { authLimiter, aiLimiter, subLimiter, adminLimiter };
