const crypto = require('crypto');

// 生成 CSRF token 并存入 session
function generateToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

// 验证 CSRF token（POST 请求）
function csrfProtection(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return next();

  // JSON API 用 Content-Type 检查（浏览器跨站表单无法发 JSON）
  if (req.is('json')) return next();

  // 表单提交检查 token
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'CSRF token 无效，请刷新页面重试' });
  }
  next();
}

// 模板中间件：自动注入 csrfToken 到 res.locals
function csrfLocals(req, res, next) {
  res.locals.csrfToken = generateToken(req);
  next();
}

module.exports = { csrfProtection, csrfLocals };
