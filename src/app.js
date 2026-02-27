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

// CSP nonce：每个请求生成唯一 nonce
const { cspNonce } = require('./middleware/cspNonce');
app.use(cspNonce);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
        // 临时兼容：当前模板大量使用 onclick 内联事件，若移除此项会导致按钮点击失效
        // 后续在全面迁移为 addEventListener 后再去掉 unsafe-inline
        "'unsafe-inline'",
      ],
      // 关键：允许 inline 事件处理器（onclick 等），否则会命中 script-src-attr 'none'
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'",
        // TODO(S14-迁移计划): 将内联 style 迁移到外部 CSS 文件后移除 unsafe-inline
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
      ],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // 允许第三方头像/外链图片（如 OAuth 用户头像）
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
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
  secret: process.env.SESSION_SECRET,
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

// Agent 自更新下载（供远端 Agent 拉取最新 agent.js）
app.get('/api/agent/download', (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).send('Unauthorized');

    const d = getDb();
    const globalToken = d.prepare("SELECT value FROM settings WHERE key='agent_token'").get()?.value;
    const nodeToken = d.prepare('SELECT id FROM nodes WHERE agent_token = ? LIMIT 1').get(token);
    const donateToken = d.prepare('SELECT id FROM donate_tokens WHERE token = ? LIMIT 1').get(token);

    if (token !== globalToken && !nodeToken && !donateToken) {
      return res.status(403).send('Forbidden');
    }

    const agentPath = path.join(__dirname, '..', 'node-agent', 'agent.js');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(agentPath);
  } catch (err) {
    logger.error({ err }, 'Agent 下载失败');
    return res.status(500).send('Internal Server Error');
  }
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
    const r3 = d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();
    logger.info({ audit: r3.changes }, '定时清理完成');

    // 自动冻结 15 天未登录的用户
    const frozen = db.autoFreezeInactiveUsers(15);
    if (frozen.length > 0) {
      logger.info({ count: frozen.length, users: frozen.map(u => u.username) }, '自动冻结不活跃用户');
      db.addAuditLog(null, 'auto_freeze', `自动冻结 ${frozen.length} 个用户: ${frozen.map(u => u.username).join(', ')}`, 'system');
      // 同步节点配置，移除冻结用户的 UUID
      await deployService.syncAllNodesConfig(db);
    }

    // Sprint 6: 自动冻结到期用户
    const expired = db.autoFreezeExpiredUsers();
    if (expired.length > 0) {
      logger.info({ count: expired.length, users: expired.map(u => u.username) }, '自动冻结到期用户');
      db.addAuditLog(null, 'auto_freeze_expired', `自动冻结 ${expired.length} 个到期用户: ${expired.map(u => u.username).join(', ')}`, 'system');
      await deployService.syncAllNodesConfig(db);
    }
    // 自动清理离线捐赠节点：离线超 24 小时 → 删除节点 + 回收捐赠者标识
    try {
      // 找出所有已审核但节点离线的捐赠记录
      const offlineDonations = d.prepare(`
        SELECT nd.id, nd.user_id, nd.node_id, n.name as node_name, n.last_check
        FROM node_donations nd
        JOIN nodes n ON nd.node_id = n.id
        WHERE nd.status = 'online' AND n.is_active = 0
      `).all();

      for (const dn of offlineDonations) {
        const hoursSince = dn.last_check ? (Date.now() - new Date(dn.last_check).getTime()) / 3600000 : 999;
        if (hoursSince < 24) continue;

        const u = db.getUserById(dn.user_id);
        const username = u?.username || `用户${dn.user_id}`;

        // 删除节点记录
        d.prepare('DELETE FROM user_node_uuid WHERE node_id = ?').run(dn.node_id);
        d.prepare('DELETE FROM nodes WHERE id = ?').run(dn.node_id);
        // 更新捐赠记录
        d.prepare("UPDATE node_donations SET status = 'offline', node_id = NULL WHERE id = ?").run(dn.id);

        logger.info(`[捐赠清理] 删除离线捐赠节点: ${dn.node_name} (${username}), 离线 ${Math.floor(hoursSince)}h`);
        db.addAuditLog(null, 'donate_cleanup', `自动删除离线捐赠节点: ${dn.node_name}, 捐赠者: ${username}, 离线${Math.floor(hoursSince)}h`, 'system');
      }

      // 检查捐赠者是否还有在线节点，没有则回收标识
      const donorUsers = d.prepare('SELECT DISTINCT user_id FROM node_donations WHERE status = ?').all('online');
      for (const { user_id } of donorUsers) {
        const activeCount = d.prepare(`
          SELECT COUNT(*) as cnt FROM node_donations nd
          JOIN nodes n ON nd.node_id = n.id
          WHERE nd.user_id = ? AND nd.status = 'online' AND n.is_active = 1
        `).get(user_id)?.cnt || 0;
        if (activeCount === 0) {
          d.prepare('UPDATE users SET is_donor = 0 WHERE id = ? AND is_donor = 1').run(user_id);
          d.prepare("UPDATE node_donations SET status = 'offline' WHERE user_id = ? AND status = 'online'").run(user_id);
          const u = db.getUserById(user_id);
          logger.info(`[捐赠回收] 回收捐赠者标识: ${u?.username || user_id}`);
          db.addAuditLog(null, 'donor_revoke', `回收捐赠者标识: ${u?.username || user_id} (无在线捐赠节点)`, 'system');
        }
      }
    } catch (e) { logger.error({ err: e }, '捐赠清理失败'); }

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
