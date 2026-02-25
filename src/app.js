require('dotenv').config();

// O9: 启动时 .env 校验（必须在其他模块加载前）
const { validateEnv } = require('./services/env-check');
validateEnv();

const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const morgan = require('morgan');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');
const logger = require('./services/logger');
const fs = require('fs');
const { performBackup, BACKUP_DIR } = require('./services/backup');

const { setupAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const panelRoutes = require('./routes/panel');
const adminRoutes = require('./routes/admin');
const adminApiRoutes = require('./routes/adminApi');
const rotateService = require('./services/rotate');
const trafficService = require('./services/traffic');
const dbModule = require('./services/database');
const { getDb } = dbModule;
const deployService = require('./services/deploy');
const { configEvents } = require('./services/configEvents');

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
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// CSRF 防护
app.use(csrfLocals);

// 配置同步事件监听
configEvents.on('sync-all', () => {
  deployService.syncAllNodesConfig(dbModule).catch(err => console.error('[配置同步]', err));
});
configEvents.on('sync-node', (node) => {
  deployService.syncNodeConfig(node, dbModule).catch(err => console.error('[配置同步]', err));
});

// 路由
app.use('/auth/nodeloc', authLimiter);
app.use('/auth/callback', authLimiter);
app.use('/auth', authRoutes);
app.use('/admin/api', adminLimiter, csrfProtection, adminApiRoutes);
app.use('/admin', adminRoutes);
app.use('/', panelRoutes);

// O2: 健康检查端点
app.get('/healthz', (req, res) => {
  try {
    const d = getDb();
    d.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, '健康检查失败');
    res.status(503).json({ status: 'error', error: 'database unreachable' });
  }
});

// 404 + 全局错误处理
app.use(notFoundHandler);
app.use(errorHandler);

// 定时轮换任务（默认每天凌晨 3 点）
cron.schedule('0 3 * * *', async () => {
  logger.info('[CRON] 开始自动轮换...');
  try {
    await rotateService.rotateAll();
    logger.info('[CRON] 轮换完成');
  } catch (err) {
    logger.error({ err }, '[CRON] 轮换失败');
  }
}, { timezone: 'Asia/Shanghai' });

// 每天凌晨 4 点清理过期数据 + 自动冻结不活跃用户
cron.schedule('0 4 * * *', async () => {
  try {
    const db = dbModule;
    const d = db.getDb();
    const r1 = d.prepare("DELETE FROM ai_chats WHERE created_at < datetime('now', '-30 days')").run();
    const r2 = d.prepare("DELETE FROM ai_sessions WHERE updated_at < datetime('now', '-30 days')").run();
    const r3 = d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();
    logger.info({ chat: r1.changes, session: r2.changes, audit: r3.changes }, '定时清理完成');

    // 自动冻结 15 天未登录的用户
    const frozen = db.autoFreezeInactiveUsers(15);
    if (frozen.length > 0) {
      logger.info({ count: frozen.length, users: frozen.map(u => u.username) }, '自动冻结不活跃用户');
      db.addAuditLog(null, 'auto_freeze', `自动冻结 ${frozen.length} 个用户: ${frozen.map(u => u.username).join(', ')}`, 'system');
      // 同步节点配置，移除冻结用户的 UUID
      await deployService.syncAllNodesConfig(db);
    }
  } catch (err) { logger.error({ err }, '清理/冻结失败'); }
}, { timezone: 'Asia/Shanghai' });

// 启动
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development', whitelist: process.env.WHITELIST_ENABLED === 'true' }, '🚀 VLESS 节点面板已启动');
  // 记录面板启动
  const db = dbModule;
  db.addAuditLog(null, 'panel_start', `面板启动 端口:${PORT} 环境:${process.env.NODE_ENV || 'development'}`, 'system');

  // O7: 启动时清理过期审计日志
  cleanAuditLogs();

  // O4: 启动时创建备份目录并执行首次备份

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
});

// 初始化 WebSocket Agent 服务
const agentWs = require('./services/agent-ws');
agentWs.init(server);

// O4: 每天凌晨 2 点自动备份数据库
cron.schedule('0 2 * * *', () => {
  performBackup(getDb());
}, { timezone: 'Asia/Shanghai' });

// O7: 每天凌晨 4:30 清理过期审计日志和订阅访问日志（保留90天）
function cleanAuditLogs() {
  try {
    const d = getDb();
    const r1 = d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();
    // sub_access_log 表可能不存在
    let r2 = { changes: 0 };
    try {
      r2 = d.prepare("DELETE FROM sub_access_log WHERE created_at < datetime('now', '-90 days')").run();
    } catch (_) {}
    logger.info({ audit_log: r1.changes, sub_access_log: r2.changes }, '审计日志清理完成');
  } catch (err) {
    logger.error({ err }, '审计日志清理失败');
  }
}
cron.schedule('30 4 * * *', cleanAuditLogs, { timezone: 'Asia/Shanghai' });

// O3: Graceful Shutdown
function gracefulShutdown(signal) {
  logger.info({ signal }, '收到关闭信号，开始优雅关闭...');
  server.close(() => {
    logger.info('HTTP 服务器已关闭');
    // 关闭 WebSocket
    try { agentWs.shutdown(); } catch (_) {}
    // 关闭数据库
    try {
      getDb().close();
      logger.info('数据库连接已关闭');
    } catch (_) {}
    process.exit(0);
  });
  // 5秒超时强制退出
  setTimeout(() => {
    logger.warn('优雅关闭超时，强制退出');
    process.exit(1);
  }, 5000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;
