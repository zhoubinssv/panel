require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const morgan = require('morgan');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');

const { setupAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const panelRoutes = require('./routes/panel');
const adminRoutes = require('./routes/admin');
const adminApiRoutes = require('./routes/adminApi');
const rotateService = require('./services/rotate');
const healthService = require('./services/health');
const trafficService = require('./services/traffic');
const { getDb } = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));
app.use(morgan('short'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 信任 nginx 反代
app.set('trust proxy', 1);

// Session（持久化到 SQLite）
app.use(session({
  store: new SqliteStore({ client: getDb(), expired: { clear: true, intervalMs: 3600000 } }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 天
  }
}));

// 认证
setupAuth(app);

const { authLimiter, adminLimiter } = require('./middleware/rateLimit');
const { csrfProtection, csrfLocals } = require('./middleware/csrf');

// CSRF 防护
app.use(csrfLocals);

// 路由
app.use('/auth/nodeloc', authLimiter);
app.use('/auth/callback', authLimiter);
app.use('/auth', authRoutes);
app.use('/admin/api', adminLimiter, csrfProtection, adminApiRoutes);
app.use('/admin', adminRoutes);
app.use('/', panelRoutes);

// 404
app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 · 小姨子的诱惑</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍑</text></svg>">
    <script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-[#0c0a0f] min-h-screen flex items-center justify-center">
      <div class="text-center">
        <p class="text-5xl mb-3">🍑</p>
        <p class="text-6xl mb-4">🫥</p>
        <h1 class="text-white text-2xl font-bold mb-2">页面不存在</h1>
        <a href="/" class="text-rose-400 hover:underline">返回首页</a>
      </div>
    </body></html>
  `);
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[错误]', err.stack || err);
  const isApi = req.path.startsWith('/admin/api') || req.headers.accept?.includes('json');
  if (isApi) return res.status(500).json({ error: '服务器内部错误' });
  res.status(500).send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>500 · 小姨子的诱惑</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍑</text></svg>">
    <script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-[#0c0a0f] min-h-screen flex items-center justify-center">
      <div class="text-center">
        <p class="text-5xl mb-3">🍑</p>
        <p class="text-6xl mb-4">💥</p>
        <h1 class="text-white text-2xl font-bold mb-2">服务器开小差了</h1>
        <p class="text-gray-400 mb-4">请稍后再试</p>
        <a href="/" class="text-rose-400 hover:underline">返回首页</a>
      </div>
    </body></html>
  `);
});

// 定时轮换任务（默认每天凌晨 3 点）
cron.schedule('0 3 * * *', async () => {
  console.log('[CRON] 开始自动轮换...');
  try {
    await rotateService.rotateAll();
  } catch (err) {
    console.error('[CRON] 轮换失败:', err);
  }
}, { timezone: 'Asia/Shanghai' });

// 每天凌晨 4 点清理过期数据
cron.schedule('0 4 * * *', () => {
  try {
    const db = require('./services/database').getDb();
    const r1 = db.prepare("DELETE FROM ai_chats WHERE created_at < datetime('now', '-30 days')").run();
    const r2 = db.prepare("DELETE FROM ai_sessions WHERE updated_at < datetime('now', '-30 days')").run();
    const r3 = db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now', '-90 days')").run();
    console.log(`[清理] 聊天:${r1.changes} 会话:${r2.changes} 日志:${r3.changes}`);
  } catch (err) { console.error('[清理] 失败:', err); }
}, { timezone: 'Asia/Shanghai' });

// 健康检测（每 5 分钟）
cron.schedule('*/5 * * * *', async () => {
  try {
    await healthService.checkAllNodes();
  } catch (err) {
    console.error('[健康检测] 失败:', err);
  }
}, { timezone: 'Asia/Shanghai' });

// 流量采集（每 10 分钟）
cron.schedule('*/10 * * * *', async () => {
  try {
    await trafficService.collectAllTraffic();
  } catch (err) {
    console.error('[流量采集] 失败:', err);
  }
}, { timezone: 'Asia/Shanghai' });

// 启动
app.listen(PORT, () => {
  console.log(`🚀 VLESS 节点面板已启动: http://localhost:${PORT}`);
  console.log(`📋 环境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 白名单: ${process.env.WHITELIST_ENABLED === 'true' ? '开启' : '关闭'}`);
});

module.exports = app;
