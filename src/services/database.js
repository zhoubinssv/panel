const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt } = require('../utils/crypto');

// 子模块
const userRepo = require('./repos/userRepo');
const nodeRepo = require('./repos/nodeRepo');
const trafficRepo = require('./repos/trafficRepo');
const settingsRepo = require('./repos/settingsRepo');
const uuidRepo = require('./repos/uuidRepo');
const awsRepo = require('./repos/awsRepo');
const aiRepo = require('./repos/aiRepo');
const subAccessRepo = require('./repos/subAccessRepo');
const opsRepo = require('./repos/opsRepo');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'panel.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
    initRepos();
  }
  return db;
}

function initRepos() {
  const deps = { getDb };
  settingsRepo.init(deps);
  nodeRepo.init(deps);
  // userRepo 需要额外依赖
  userRepo.init({
    getDb,
    getSetting: settingsRepo.getSetting,
    addAuditLog: settingsRepo.addAuditLog,
    ensureUserHasAllNodeUuids: uuidRepo.ensureUserHasAllNodeUuids,
    removeFromRegisterWhitelist: settingsRepo.removeFromRegisterWhitelist,
  });
  uuidRepo.init({
    getDb,
    getAllUsers: userRepo.getAllUsers,
    getAllNodes: nodeRepo.getAllNodes,
  });
  trafficRepo.init({ getDb, getUserById: userRepo.getUserById });
  awsRepo.init(deps);
  aiRepo.init(deps);
  subAccessRepo.init({ getDb, getUserById: userRepo.getUserById });
  opsRepo.init(deps);
}

function initTables() {
  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      nodeloc_id INTEGER UNIQUE NOT NULL,
      username TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      trust_level INTEGER DEFAULT 0,
      email TEXT,
      sub_token TEXT UNIQUE NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      is_frozen INTEGER DEFAULT 0,
      traffic_limit INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 3,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    -- 白名单表
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );

    -- 节点表
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      protocol TEXT DEFAULT 'vless',
      network TEXT DEFAULT 'tcp',
      security TEXT DEFAULT 'none',
      ssh_host TEXT,
      ssh_port INTEGER DEFAULT 22,
      ssh_user TEXT DEFAULT 'root',
      ssh_password TEXT,
      ssh_key_path TEXT,
      xray_config_path TEXT DEFAULT '/usr/local/etc/xray/config.json',
      socks5_host TEXT,
      socks5_port INTEGER DEFAULT 1080,
      socks5_user TEXT,
      socks5_pass TEXT,
      is_active INTEGER DEFAULT 1,
      region TEXT,
      remark TEXT,
      last_rotated TEXT,
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 审计日志
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 系统配置
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 用户-节点 UUID 映射表
    CREATE TABLE IF NOT EXISTS user_node_uuid (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      UNIQUE(user_id, node_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    -- 流量统计表
    CREATE TABLE IF NOT EXISTS traffic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      uplink INTEGER DEFAULT 0,
      downlink INTEGER DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    -- AI 服务商配置表
    CREATE TABLE IF NOT EXISTS ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('openai', 'gemini', 'claude')),
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL DEFAULT '',
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- AI 对话历史表
    CREATE TABLE IF NOT EXISTS ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL DEFAULT 'default',
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      provider_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- AI 会话表
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 流量汇总表（按天）
    CREATE TABLE IF NOT EXISTS traffic_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER,
      date TEXT NOT NULL,
      uplink INTEGER DEFAULT 0,
      downlink INTEGER DEFAULT 0,
      UNIQUE(user_id, node_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    -- 订阅拉取 IP 记录
    CREATE TABLE IF NOT EXISTS sub_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      ua TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // 运维诊断表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_diagnosis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      diag_info TEXT,
      ai_analysis TEXT,
      fix_commands TEXT,
      fix_result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traffic_daily_user_date ON traffic_daily(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_traffic_daily_node ON traffic_daily(node_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_sub_access_log_user_time ON sub_access_log(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_user_node_uuid_node ON user_node_uuid(node_id);
    CREATE INDEX IF NOT EXISTS idx_user_node_uuid_user ON user_node_uuid(user_id);
    CREATE INDEX IF NOT EXISTS idx_traffic_user_node ON traffic(user_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_ai_chats_user_session ON ai_chats(user_id, session_id);
  `);

  // 初始化默认配置
  const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('whitelist_enabled', 'false');
  upsert.run('announcement', '');
  upsert.run('rotate_cron', '0 3 * * *');
  upsert.run('rotate_port_min', '10000');
  upsert.run('rotate_port_max', '60000');
  upsert.run('max_users', '0');
  upsert.run('default_traffic_limit', '0');
  upsert.run('agent_token', uuidv4());

  // 注册白名单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS register_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 迁移
  const cols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!cols.includes('socks5_host')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN socks5_host TEXT;
      ALTER TABLE nodes ADD COLUMN socks5_port INTEGER DEFAULT 1080;
      ALTER TABLE nodes ADD COLUMN socks5_user TEXT;
      ALTER TABLE nodes ADD COLUMN socks5_pass TEXT;
    `);
  }
  if (!cols.includes('min_level')) {
    db.exec("ALTER TABLE nodes ADD COLUMN min_level INTEGER DEFAULT 0");
  }
  if (!cols.includes('reality_private_key')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN reality_private_key TEXT;
      ALTER TABLE nodes ADD COLUMN reality_public_key TEXT;
      ALTER TABLE nodes ADD COLUMN reality_short_id TEXT;
      ALTER TABLE nodes ADD COLUMN sni TEXT DEFAULT 'www.microsoft.com';
    `);
  }
  if (!cols.includes('aws_instance_id')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN aws_instance_id TEXT;
      ALTER TABLE nodes ADD COLUMN aws_type TEXT DEFAULT 'ec2';
      ALTER TABLE nodes ADD COLUMN aws_region TEXT;
    `);
  }
  if (!cols.includes('aws_account_id')) {
    db.exec("ALTER TABLE nodes ADD COLUMN aws_account_id INTEGER");
  }
  if (!cols.includes('is_manual')) {
    db.exec("ALTER TABLE nodes ADD COLUMN is_manual INTEGER DEFAULT 0");
  }
  if (!cols.includes('fail_count')) {
    db.exec("ALTER TABLE nodes ADD COLUMN fail_count INTEGER DEFAULT 0");
  }
  if (!cols.includes('agent_last_report')) {
    db.exec("ALTER TABLE nodes ADD COLUMN agent_last_report TEXT");
  }
  if (!cols.includes('agent_token')) {
    db.exec("ALTER TABLE nodes ADD COLUMN agent_token TEXT");
    const existingNodes = db.prepare('SELECT id FROM nodes').all();
    const updateStmt = db.prepare('UPDATE nodes SET agent_token = ? WHERE id = ?');
    for (const n of existingNodes) {
      updateStmt.run(uuidv4(), n.id);
    }
  }

  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('is_frozen')) {
    db.exec("ALTER TABLE users ADD COLUMN is_frozen INTEGER DEFAULT 0");
  }
  if (!userCols.includes('traffic_limit')) {
    db.exec("ALTER TABLE users ADD COLUMN traffic_limit INTEGER DEFAULT 0");
  }

  // AWS 多账号表
  db.exec(`
    CREATE TABLE IF NOT EXISTS aws_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      access_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      default_region TEXT DEFAULT 'us-east-1',
      socks5_host TEXT,
      socks5_port INTEGER DEFAULT 1080,
      socks5_user TEXT,
      socks5_pass TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // AI 运营日记表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      mood TEXT DEFAULT '🐱',
      category TEXT DEFAULT 'ops',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 迁移：白名单表改用 nodeloc_id
  const wlCols = db.prepare("PRAGMA table_info(whitelist)").all().map(c => c.name);
  if (!wlCols.includes('nodeloc_id')) {
    db.exec("DROP TABLE IF EXISTS whitelist");
    db.exec(`CREATE TABLE whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeloc_id INTEGER UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )`);
  }

  // 迁移：traffic_daily 去掉 CASCADE
  const tdFk = db.prepare("PRAGMA foreign_key_list(traffic_daily)").all();
  const hasCascade = tdFk.some(f => f.table === 'nodes' && f.on_delete === 'CASCADE');
  if (hasCascade) {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(`
      CREATE TABLE traffic_daily_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        node_id INTEGER,
        date TEXT NOT NULL,
        uplink INTEGER DEFAULT 0,
        downlink INTEGER DEFAULT 0,
        UNIQUE(user_id, node_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO traffic_daily_new SELECT * FROM traffic_daily;
      DROP TABLE traffic_daily;
      ALTER TABLE traffic_daily_new RENAME TO traffic_daily;
    `);
    db.exec("PRAGMA foreign_keys=ON");
  }

  const aiCols = db.prepare("PRAGMA table_info(ai_providers)").all().map(c => c.name);
  if (!aiCols.includes('system_prompt')) {
    db.exec("ALTER TABLE ai_providers ADD COLUMN system_prompt TEXT DEFAULT ''");
  }

  const chatCols = db.prepare("PRAGMA table_info(ai_chats)").all().map(c => c.name);
  if (!chatCols.includes('session_id')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!chatCols.includes('provider_id')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN provider_id INTEGER");
  }
}

// 导出所有函数（向后兼容）
module.exports = {
  getDb,
  // 用户
  findOrCreateUser: (...a) => userRepo.findOrCreateUser(...a),
  getUserBySubToken: (...a) => userRepo.getUserBySubToken(...a),
  getUserById: (...a) => userRepo.getUserById(...a),
  getUserCount: (...a) => userRepo.getUserCount(...a),
  getAllUsers: (...a) => userRepo.getAllUsers(...a),
  getAllUsersPaged: (...a) => userRepo.getAllUsersPaged(...a),
  blockUser: (...a) => userRepo.blockUser(...a),
  setUserTrafficLimit: (...a) => userRepo.setUserTrafficLimit(...a),
  isTrafficExceeded: (...a) => userRepo.isTrafficExceeded(...a),
  freezeUser: (...a) => userRepo.freezeUser(...a),
  unfreezeUser: (...a) => userRepo.unfreezeUser(...a),
  autoFreezeInactiveUsers: (...a) => userRepo.autoFreezeInactiveUsers(...a),
  resetSubToken: (...a) => userRepo.resetSubToken(...a),
  // 节点
  getAllNodes: (...a) => nodeRepo.getAllNodes(...a),
  getNodeById: (...a) => nodeRepo.getNodeById(...a),
  addNode: (...a) => nodeRepo.addNode(...a),
  updateNode: (...a) => nodeRepo.updateNode(...a),
  deleteNode: (...a) => nodeRepo.deleteNode(...a),
  updateNodeAfterRotation: (...a) => nodeRepo.updateNodeAfterRotation(...a),
  // UUID
  getUserNodeUuid: (...a) => uuidRepo.getUserNodeUuid(...a),
  getUserAllNodeUuids: (...a) => uuidRepo.getUserAllNodeUuids(...a),
  getNodeAllUserUuids: (...a) => uuidRepo.getNodeAllUserUuids(...a),
  ensureAllUsersHaveUuid: (...a) => uuidRepo.ensureAllUsersHaveUuid(...a),
  ensureUserHasAllNodeUuids: (...a) => uuidRepo.ensureUserHasAllNodeUuids(...a),
  rotateAllUserNodeUuids: (...a) => uuidRepo.rotateAllUserNodeUuids(...a),
  rotateUserNodeUuidsByNodeIds: (...a) => uuidRepo.rotateUserNodeUuidsByNodeIds(...a),
  // 流量
  recordTraffic: (...a) => trafficRepo.recordTraffic(...a),
  getUserTraffic: (...a) => trafficRepo.getUserTraffic(...a),
  getAllUsersTraffic: (...a) => trafficRepo.getAllUsersTraffic(...a),
  getNodeTraffic: (...a) => trafficRepo.getNodeTraffic(...a),
  getGlobalTraffic: (...a) => trafficRepo.getGlobalTraffic(...a),
  getTodayTraffic: (...a) => trafficRepo.getTodayTraffic(...a),
  getUsersTrafficByRange: (...a) => trafficRepo.getUsersTrafficByRange(...a),
  getNodesTrafficByRange: (...a) => trafficRepo.getNodesTrafficByRange(...a),
  getTrafficTrend: (...a) => trafficRepo.getTrafficTrend(...a),
  // 设置 & 审计 & 白名单
  addAuditLog: (...a) => settingsRepo.addAuditLog(...a),
  getAuditLogs: (...a) => settingsRepo.getAuditLogs(...a),
  clearAuditLogs: (...a) => settingsRepo.clearAuditLogs(...a),
  getSetting: (...a) => settingsRepo.getSetting(...a),
  setSetting: (...a) => settingsRepo.setSetting(...a),
  isInWhitelist: (...a) => settingsRepo.isInWhitelist(...a),
  getWhitelist: (...a) => settingsRepo.getWhitelist(...a),
  addToWhitelist: (...a) => settingsRepo.addToWhitelist(...a),
  removeFromWhitelist: (...a) => settingsRepo.removeFromWhitelist(...a),
  isInRegisterWhitelist: (...a) => settingsRepo.isInRegisterWhitelist(...a),
  getRegisterWhitelist: (...a) => settingsRepo.getRegisterWhitelist(...a),
  addToRegisterWhitelist: (...a) => settingsRepo.addToRegisterWhitelist(...a),
  removeFromRegisterWhitelist: (...a) => settingsRepo.removeFromRegisterWhitelist(...a),
  // AWS
  getAwsAccounts: (...a) => awsRepo.getAwsAccounts(...a),
  getAwsAccountById: (...a) => awsRepo.getAwsAccountById(...a),
  addAwsAccount: (...a) => awsRepo.addAwsAccount(...a),
  updateAwsAccount: (...a) => awsRepo.updateAwsAccount(...a),
  deleteAwsAccount: (...a) => awsRepo.deleteAwsAccount(...a),
  // AI
  getAllAiProviders: (...a) => aiRepo.getAllAiProviders(...a),
  getEnabledAiProviders: (...a) => aiRepo.getEnabledAiProviders(...a),
  getAiProviderById: (...a) => aiRepo.getAiProviderById(...a),
  addAiProvider: (...a) => aiRepo.addAiProvider(...a),
  updateAiProvider: (...a) => aiRepo.updateAiProvider(...a),
  deleteAiProvider: (...a) => aiRepo.deleteAiProvider(...a),
  addAiChat: (...a) => aiRepo.addAiChat(...a),
  getAiChatHistory: (...a) => aiRepo.getAiChatHistory(...a),
  clearAiChatHistory: (...a) => aiRepo.clearAiChatHistory(...a),
  createAiSession: (...a) => aiRepo.createAiSession(...a),
  getAiSessions: (...a) => aiRepo.getAiSessions(...a),
  getAiSessionById: (...a) => aiRepo.getAiSessionById(...a),
  updateAiSessionTitle: (...a) => aiRepo.updateAiSessionTitle(...a),
  deleteAiSession: (...a) => aiRepo.deleteAiSession(...a),
  // 订阅访问
  logSubAccess: (...a) => subAccessRepo.logSubAccess(...a),
  getSubAccessIPs: (...a) => subAccessRepo.getSubAccessIPs(...a),
  getSubAbuseUsers: (...a) => subAccessRepo.getSubAbuseUsers(...a),
  getSubAccessStats: (...a) => subAccessRepo.getSubAccessStats(...a),
  getSubAccessUserDetail: (...a) => subAccessRepo.getSubAccessUserDetail(...a),
  // 运维
  addDiagnosis: (...a) => opsRepo.addDiagnosis(...a),
  updateDiagnosis: (...a) => opsRepo.updateDiagnosis(...a),
  getDiagnosis: (...a) => opsRepo.getDiagnosis(...a),
  getAllDiagnoses: (...a) => opsRepo.getAllDiagnoses(...a),
  clearDiagnoses: (...a) => opsRepo.clearDiagnoses(...a),
  addDiaryEntry: (...a) => opsRepo.addDiaryEntry(...a),
  getDiaryEntries: (...a) => opsRepo.getDiaryEntries(...a),
  getDiaryStats: (...a) => opsRepo.getDiaryStats(...a),
};
