const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt } = require('../utils/crypto');

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
  }
  return db;
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

  // 初始化默认配置
  const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('whitelist_enabled', 'false');
  upsert.run('announcement', '');
  upsert.run('rotate_cron', '0 3 * * *');
  upsert.run('rotate_port_min', '10000');
  upsert.run('rotate_port_max', '60000');
  upsert.run('max_users', '0'); // 0 = 不限制
  upsert.run('default_traffic_limit', '0'); // 0 = 无限，单位字节
  upsert.run('agent_token', uuidv4()); // Agent 认证 token

  // 注册白名单表（满额时允许特定用户名注册，注册后自动移除）
  db.exec(`
    CREATE TABLE IF NOT EXISTS register_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 迁移：给 nodes 表补充 socks5 字段（已有表可能缺少）
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
    // 为现有节点生成独立 token
    const { v4: migrateUuid } = require('uuid');
    const existingNodes = db.prepare('SELECT id FROM nodes').all();
    const updateStmt = db.prepare('UPDATE nodes SET agent_token = ? WHERE id = ?');
    for (const n of existingNodes) {
      updateStmt.run(migrateUuid(), n.id);
    }
  }

  // 迁移：用户表补充 is_frozen 字段
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

  // 迁移：traffic_daily 去掉 CASCADE，改为 SET NULL 保留流量数据
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

  // 迁移：给 ai_providers 表补充 system_prompt 字段
  const aiCols = db.prepare("PRAGMA table_info(ai_providers)").all().map(c => c.name);
  if (!aiCols.includes('system_prompt')) {
    db.exec("ALTER TABLE ai_providers ADD COLUMN system_prompt TEXT DEFAULT ''");
  }

  // 迁移：给 ai_chats 表补充 session_id 字段
  const chatCols = db.prepare("PRAGMA table_info(ai_chats)").all().map(c => c.name);
  if (!chatCols.includes('session_id')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!chatCols.includes('provider_id')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN provider_id INTEGER");
  }
}

// ========== 用户操作 ==========

function findOrCreateUser(profile) {
  const existing = getDb().prepare('SELECT * FROM users WHERE nodeloc_id = ?').get(profile.id);
  if (existing) {
    const wasFrozen = existing.is_frozen;
    getDb().prepare(`
      UPDATE users SET username = ?, name = ?, avatar_url = ?, trust_level = ?, email = ?, is_frozen = 0, last_login = datetime('now')
      WHERE nodeloc_id = ?
    `).run(profile.username, profile.name, profile.avatar_url, profile.trust_level, profile.email, profile.id);
    const user = getDb().prepare('SELECT * FROM users WHERE nodeloc_id = ?').get(profile.id);
    // 冻结用户登录时自动解冻，重新分配所有节点 UUID
    if (wasFrozen) {
      ensureUserHasAllNodeUuids(user.id);
      user._wasFrozen = true;
    }
    return user;
  }

  const subToken = uuidv4();
  // 第一个注册的用户自动成为管理员
  const userCount = getDb().prepare('SELECT COUNT(*) as count FROM users').get().count;
  const isAdmin = userCount === 0 ? 1 : 0;

  const defaultLimit = parseInt(getSetting('default_traffic_limit')) || 0;

  getDb().prepare(`
    INSERT INTO users (nodeloc_id, username, name, avatar_url, trust_level, email, sub_token, is_admin, traffic_limit, last_login)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(profile.id, profile.username, profile.name, profile.avatar_url, profile.trust_level, profile.email, subToken, isAdmin, defaultLimit);

  const newUser = getDb().prepare('SELECT * FROM users WHERE nodeloc_id = ?').get(profile.id);
  if (isAdmin) console.log(`👑 首位用户 ${profile.username} 已自动设为管理员`);

  // 记录新用户注册
  addAuditLog(null, 'user_register', `新用户注册: ${profile.username}${isAdmin ? ' (管理员)' : ''}`, 'system');

  // TG 通知新用户注册
  try { const { notify } = require('./notify'); notify.userRegister(profile.username); } catch {}

  // 为新用户在所有节点生成 UUID
  ensureUserHasAllNodeUuids(newUser.id);

  // 注册成功后自动从注册白名单移除
  removeFromRegisterWhitelist(profile.username);

  return newUser;
}

function getUserBySubToken(token) {
  return getDb().prepare('SELECT * FROM users WHERE sub_token = ? AND is_blocked = 0 AND is_frozen = 0').get(token);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM users').get().count;
}

function getAllUsers() {
  return getDb().prepare(`
    SELECT u.*, COALESCE(SUM(t.uplink),0)+COALESCE(SUM(t.downlink),0) as total_traffic
    FROM users u LEFT JOIN traffic_daily t ON u.id = t.user_id
    GROUP BY u.id ORDER BY total_traffic DESC
  `).all();
}

function blockUser(id, blocked) {
  getDb().prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
}

function setUserTrafficLimit(id, limitBytes) {
  getDb().prepare('UPDATE users SET traffic_limit = ? WHERE id = ?').run(limitBytes, id);
}

function isTrafficExceeded(userId) {
  const user = getUserById(userId);
  if (!user || !user.traffic_limit) return false;
  const traffic = getDb().prepare(
    'SELECT COALESCE(SUM(uplink), 0) + COALESCE(SUM(downlink), 0) as total FROM traffic_daily WHERE user_id = ?'
  ).get(userId);
  return traffic.total >= user.traffic_limit;
}

// 冻结用户：删除其所有 node UUID
function freezeUser(id) {
  getDb().prepare('UPDATE users SET is_frozen = 1 WHERE id = ?').run(id);
  getDb().prepare('DELETE FROM user_node_uuid WHERE user_id = ?').run(id);
}

// 解冻用户：恢复并分配所有节点 UUID
function unfreezeUser(id) {
  getDb().prepare('UPDATE users SET is_frozen = 0 WHERE id = ?').run(id);
  ensureUserHasAllNodeUuids(id);
}

// 自动冻结超过 N 天未登录的用户（返回被冻结的用户列表）
function autoFreezeInactiveUsers(days = 15) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const users = getDb().prepare(
    "SELECT id, username FROM users WHERE is_frozen = 0 AND is_blocked = 0 AND is_admin = 0 AND last_login < ?"
  ).all(cutoff);
  for (const u of users) {
    freezeUser(u.id);
  }
  return users;
}

function resetSubToken(userId) {
  const newToken = uuidv4();
  getDb().prepare('UPDATE users SET sub_token = ? WHERE id = ?').run(newToken, userId);
  return newToken;
}

// ========== 白名单操作（节点访问白名单）==========

function isInWhitelist(nodeloc_id) {
  return !!getDb().prepare('SELECT 1 FROM whitelist WHERE nodeloc_id = ?').get(nodeloc_id);
}

function getWhitelist() {
  return getDb().prepare(`
    SELECT w.*, u.username, u.name FROM whitelist w
    LEFT JOIN users u ON w.nodeloc_id = u.nodeloc_id
    ORDER BY w.added_at DESC
  `).all();
}

function addToWhitelist(nodeloc_id) {
  getDb().prepare('INSERT OR IGNORE INTO whitelist (nodeloc_id) VALUES (?)').run(nodeloc_id);
}

function removeFromWhitelist(nodeloc_id) {
  getDb().prepare('DELETE FROM whitelist WHERE nodeloc_id = ?').run(nodeloc_id);
}

// ========== 注册白名单（满额时允许特定用户名注册）==========

function isInRegisterWhitelist(username) {
  return !!getDb().prepare('SELECT 1 FROM register_whitelist WHERE username = ?').get(username);
}

function getRegisterWhitelist() {
  return getDb().prepare('SELECT * FROM register_whitelist ORDER BY added_at DESC').all();
}

function addToRegisterWhitelist(username) {
  getDb().prepare('INSERT OR IGNORE INTO register_whitelist (username) VALUES (?)').run(username.trim());
}

function removeFromRegisterWhitelist(username) {
  getDb().prepare('DELETE FROM register_whitelist WHERE username = ?').run(username.trim());
}

// ========== 节点操作 ==========

// 解密节点敏感字段
function decryptNode(node) {
  if (!node) return node;
  node.ssh_password = decrypt(node.ssh_password);
  node.socks5_pass = decrypt(node.socks5_pass);
  return node;
}

function getAllNodes(activeOnly = false) {
  const rows = activeOnly
    ? getDb().prepare('SELECT * FROM nodes WHERE is_active = 1 ORDER BY region, name').all()
    : getDb().prepare('SELECT * FROM nodes ORDER BY is_active DESC, region, name').all();
  return rows.map(decryptNode);
}

function getNodeById(id) {
  return decryptNode(getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id));
}

function addNode(node) {
  const stmt = getDb().prepare(`
    INSERT INTO nodes (name, host, port, uuid, protocol, network, security, ssh_host, ssh_port, ssh_user, ssh_password, ssh_key_path, xray_config_path, socks5_host, socks5_port, socks5_user, socks5_pass, is_active, region, remark, is_manual, fail_count, agent_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    node.name, node.host, node.port, node.uuid,
    node.protocol || 'vless', node.network || 'tcp', node.security || 'none',
    node.ssh_host, node.ssh_port || 22, node.ssh_user || 'root',
    encrypt(node.ssh_password) || null, node.ssh_key_path,
    node.xray_config_path || '/usr/local/etc/xray/config.json',
    node.socks5_host || null, node.socks5_port || 1080,
    node.socks5_user || null, encrypt(node.socks5_pass) || null,
    node.is_active !== undefined ? node.is_active : 1,
    node.region, node.remark,
    node.is_manual ? 1 : 0,
    node.fail_count || 0,
    node.agent_token || uuidv4()
  );
}

function updateNode(id, fields) {
  const allowed = ['name','host','port','uuid','ssh_host','ssh_port','ssh_user','ssh_password','ssh_key_path','region','remark','is_active','last_check','last_rotated','socks5_host','socks5_port','socks5_user','socks5_pass','min_level','reality_private_key','reality_public_key','reality_short_id','sni','aws_instance_id','aws_type','aws_region','aws_account_id','is_manual','fail_count','agent_last_report','agent_token'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  const values = Object.values(safe);
  getDb().prepare(`UPDATE nodes SET ${sets} WHERE id = ?`).run(...values, id);
}

function deleteNode(id) {
  getDb().prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

function updateNodeAfterRotation(id, newUuid, newPort) {
  getDb().prepare(`
    UPDATE nodes SET uuid = ?, port = ?, last_rotated = datetime('now') WHERE id = ?
  `).run(newUuid, newPort, id);
}

// ========== 审计日志 ==========

function addAuditLog(userId, action, detail, ip) {
  getDb().prepare('INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, ?, ?, ?)').run(userId, action, detail, ip);
}

function getAuditLogs(limit = 50, offset = 0, type = 'all') {
  const where = type === 'system' ? "WHERE a.ip = 'system'" : type === 'user' ? "WHERE a.ip != 'system'" : '';
  const rows = getDb().prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = getDb().prepare(`SELECT COUNT(*) as c FROM audit_log a ${where}`).get().c;
  return { rows, total };
}

function clearAuditLogs() {
  getDb().prepare('DELETE FROM audit_log').run();
}

// ========== 系统配置 ==========

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ========== AWS 账号 ==========

function decryptAwsAccount(a) {
  if (!a) return a;
  a.access_key = decrypt(a.access_key);
  a.secret_key = decrypt(a.secret_key);
  a.socks5_pass = decrypt(a.socks5_pass);
  return a;
}

function getAwsAccounts(enabledOnly = false) {
  const rows = enabledOnly
    ? getDb().prepare('SELECT * FROM aws_accounts WHERE enabled = 1 ORDER BY id DESC').all()
    : getDb().prepare('SELECT * FROM aws_accounts ORDER BY id DESC').all();
  return rows.map(decryptAwsAccount);
}

function getAwsAccountById(id) {
  return decryptAwsAccount(getDb().prepare('SELECT * FROM aws_accounts WHERE id = ?').get(id));
}

function addAwsAccount(account) {
  return getDb().prepare(`
    INSERT INTO aws_accounts (name, access_key, secret_key, default_region, socks5_host, socks5_port, socks5_user, socks5_pass, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    account.name,
    encrypt(account.access_key),
    encrypt(account.secret_key),
    account.default_region || 'ap-northeast-1',
    account.socks5_host || null,
    account.socks5_port || 1080,
    account.socks5_user || null,
    encrypt(account.socks5_pass) || null,
    account.enabled === false ? 0 : 1
  );
}

function updateAwsAccount(id, fields) {
  const safe = { ...fields };
  if (safe.access_key) safe.access_key = encrypt(safe.access_key);
  if (safe.secret_key) safe.secret_key = encrypt(safe.secret_key);
  if (safe.socks5_pass) safe.socks5_pass = encrypt(safe.socks5_pass);
  const allowed = ['name','access_key','secret_key','default_region','socks5_host','socks5_port','socks5_user','socks5_pass','enabled'];
  const obj = Object.fromEntries(Object.entries(safe).filter(([k]) => allowed.includes(k)));
  obj.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE aws_accounts SET ${sets} WHERE id = ?`).run(...keys.map(k => obj[k]), id);
}

function deleteAwsAccount(id) {
  getDb().prepare('DELETE FROM aws_accounts WHERE id = ?').run(id);
}

// ========== 用户-节点 UUID 映射 ==========

// 获取或创建用户在某节点的 UUID
function getUserNodeUuid(userId, nodeId) {
  let row = getDb().prepare('SELECT * FROM user_node_uuid WHERE user_id = ? AND node_id = ?').get(userId, nodeId);
  if (!row) {
    const newUuid = uuidv4();
    getDb().prepare('INSERT INTO user_node_uuid (user_id, node_id, uuid) VALUES (?, ?, ?)').run(userId, nodeId, newUuid);
    row = { user_id: userId, node_id: nodeId, uuid: newUuid };
  }
  return row;
}

// 获取用户在所有节点的 UUID
function getUserAllNodeUuids(userId) {
  return getDb().prepare('SELECT un.*, n.name as node_name, n.host, n.port FROM user_node_uuid un JOIN nodes n ON un.node_id = n.id WHERE un.user_id = ?').all(userId);
}

// 获取某节点的所有用户 UUID（用于生成 xray 配置）
function getNodeAllUserUuids(nodeId) {
  return getDb().prepare(`
    SELECT un.*, u.username FROM user_node_uuid un
    JOIN users u ON un.user_id = u.id
    JOIN nodes n ON un.node_id = n.id
    LEFT JOIN whitelist w ON u.nodeloc_id = w.nodeloc_id
    WHERE un.node_id = ? AND u.is_blocked = 0 AND u.is_frozen = 0
      AND (w.nodeloc_id IS NOT NULL OR u.trust_level >= n.min_level)
  `).all(nodeId);
}

// 为所有活跃用户在指定节点生成 UUID（跳过冻结和封禁用户）
function ensureAllUsersHaveUuid(nodeId) {
  const users = getAllUsers().filter(u => !u.is_frozen && !u.is_blocked);
  const stmt = getDb().prepare('INSERT OR IGNORE INTO user_node_uuid (user_id, node_id, uuid) VALUES (?, ?, ?)');
  const insertMany = getDb().transaction((users) => {
    for (const user of users) {
      stmt.run(user.id, nodeId, uuidv4());
    }
  });
  insertMany(users);
}

// 为新用户在所有节点生成 UUID
function ensureUserHasAllNodeUuids(userId) {
  const nodes = getAllNodes();
  const stmt = getDb().prepare('INSERT OR IGNORE INTO user_node_uuid (user_id, node_id, uuid) VALUES (?, ?, ?)');
  const insertMany = getDb().transaction((nodes) => {
    for (const node of nodes) {
      stmt.run(userId, node.id, uuidv4());
    }
  });
  insertMany(nodes);
}

// 轮换所有用户在所有节点的 UUID
function rotateAllUserNodeUuids() {
  const rows = getDb().prepare('SELECT id FROM user_node_uuid').all();
  const stmt = getDb().prepare('UPDATE user_node_uuid SET uuid = ? WHERE id = ?');
  const updateMany = getDb().transaction((rows) => {
    for (const row of rows) {
      stmt.run(uuidv4(), row.id);
    }
  });
  updateMany(rows);
  return rows.length;
}

// 仅轮换指定节点的用户 UUID（用于排除手动节点）
function rotateUserNodeUuidsByNodeIds(nodeIds = []) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return 0;
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id FROM user_node_uuid WHERE node_id IN (${placeholders})`).all(...nodeIds);
  const stmt = getDb().prepare('UPDATE user_node_uuid SET uuid = ? WHERE id = ?');
  const updateMany = getDb().transaction((rows) => {
    for (const row of rows) {
      stmt.run(uuidv4(), row.id);
    }
  });
  updateMany(rows);
  return rows.length;
}

// ========== 流量统计 ==========

function recordTraffic(userId, nodeId, uplink, downlink) {
  getDb().prepare('INSERT INTO traffic (user_id, node_id, uplink, downlink) VALUES (?, ?, ?, ?)').run(userId, nodeId, uplink, downlink);

  // 同时更新每日汇总
  const today = new Date().toISOString().split('T')[0];
  getDb().prepare(`
    INSERT INTO traffic_daily (user_id, node_id, date, uplink, downlink)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, node_id, date) DO UPDATE SET
      uplink = uplink + excluded.uplink,
      downlink = downlink + excluded.downlink
  `).run(userId, nodeId, today, uplink, downlink);
}

// 获取用户总流量
function getUserTraffic(userId) {
  return getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE user_id = ?
  `).get(userId);
}

// 获取所有用户流量排行（支持按日期筛选和分页）
function getAllUsersTraffic(date, limit = 20, offset = 0) {
  const where = date ? 'AND t.date = ?' : '';
  const params = date ? [date, limit, offset] : [limit, offset];
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.name, u.avatar_url,
      COALESCE(SUM(t.uplink), 0) as total_up,
      COALESCE(SUM(t.downlink), 0) as total_down
    FROM users u
    LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
    GROUP BY u.id
    HAVING total_up + total_down > 0
    ORDER BY (total_up + total_down) DESC
    LIMIT ? OFFSET ?
  `).all(...params);
  const countParams = date ? [date] : [];
  const total = getDb().prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT u.id FROM users u
      LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
      GROUP BY u.id HAVING COALESCE(SUM(t.uplink),0) + COALESCE(SUM(t.downlink),0) > 0
    )
  `).get(...countParams).c;
  return { rows, total };
}

// 获取节点流量
function getNodeTraffic(nodeId) {
  return getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE node_id = ?
  `).get(nodeId);
}

// 获取全局流量
function getGlobalTraffic() {
  return getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily
  `).get();
}

// 获取今日全局流量
function getTodayTraffic() {
  const today = new Date().toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE date = ?
  `).get(today);
}

// 按时间范围构建 date 条件
function _rangeDateCondition(range) {
  const today = new Date().toISOString().slice(0, 10);
  if (range === 'today') return { where: 'AND t.date = ?', params: [today] };
  if (range === '7d') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return { where: 'AND t.date >= ?', params: [d.toISOString().slice(0, 10)] };
  }
  if (range === '30d') {
    const d = new Date(); d.setDate(d.getDate() - 29);
    return { where: 'AND t.date >= ?', params: [d.toISOString().slice(0, 10)] };
  }
  return { where: '', params: [] }; // all
}

// 按时间范围查用户流量排行
function getUsersTrafficByRange(range, limit = 20, offset = 0) {
  const { where, params } = _rangeDateCondition(range);
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.name, u.avatar_url,
      COALESCE(SUM(t.uplink), 0) as total_up,
      COALESCE(SUM(t.downlink), 0) as total_down
    FROM users u
    LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
    GROUP BY u.id
    HAVING total_up + total_down > 0
    ORDER BY (total_up + total_down) DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = getDb().prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT u.id FROM users u
      LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
      GROUP BY u.id HAVING COALESCE(SUM(t.uplink),0) + COALESCE(SUM(t.downlink),0) > 0
    )
  `).get(...params).c;
  return { rows, total };
}

// 按时间范围查节点流量排行
function getNodesTrafficByRange(range) {
  const { where, params } = _rangeDateCondition(range);
  return getDb().prepare(`
    SELECT n.id, n.name,
      COALESCE(SUM(t.uplink), 0) as total_up,
      COALESCE(SUM(t.downlink), 0) as total_down
    FROM nodes n
    LEFT JOIN traffic_daily t ON n.id = t.node_id ${where}
    GROUP BY n.id
    HAVING total_up + total_down > 0
    ORDER BY (total_up + total_down) DESC
  `).all(...params);
}

// ========== 运维诊断 ==========

function addDiagnosis(nodeId, diagInfo) {
  return getDb().prepare('INSERT INTO ops_diagnosis (node_id, diag_info) VALUES (?, ?)').run(nodeId, diagInfo);
}

function updateDiagnosis(id, fields) {
  const allowed = ['status','ai_analysis','fix_commands','fix_result','resolved_at'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE ops_diagnosis SET ${sets} WHERE id = ?`).run(...Object.values(safe), id);
}

function getDiagnosis(id) {
  return getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id WHERE d.id = ?').get(id);
}

function clearDiagnoses() {
  getDb().prepare('DELETE FROM ops_diagnosis').run();
}

function getAllDiagnoses(limit = 20) {
  return getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id ORDER BY d.created_at DESC LIMIT ?').all(limit);
}

// ========== AI 服务商操作 ==========

function decryptProvider(p) {
  if (!p) return p;
  p.api_key = decrypt(p.api_key);
  return p;
}

function getAllAiProviders() {
  return getDb().prepare('SELECT * FROM ai_providers ORDER BY priority DESC, id ASC').all().map(decryptProvider);
}

function getEnabledAiProviders() {
  return getDb().prepare('SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY priority DESC, id ASC').all().map(decryptProvider);
}

function getAiProviderById(id) {
  return decryptProvider(getDb().prepare('SELECT * FROM ai_providers WHERE id = ?').get(id));
}

function addAiProvider(provider) {
  return getDb().prepare(`
    INSERT INTO ai_providers (type, name, endpoint, api_key, model_id, model_name, enabled, priority, system_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    provider.type, provider.name, provider.endpoint, encrypt(provider.api_key),
    provider.model_id, provider.model_name || '', provider.enabled ? 1 : 0, provider.priority || 0,
    provider.system_prompt || ''
  );
}

function updateAiProvider(id, fields) {
  if (fields.api_key) fields.api_key = encrypt(fields.api_key);
  fields.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const allowed = ['type','name','endpoint','api_key','model_id','model_name','enabled','priority','system_prompt','updated_at'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  const values = Object.values(safe);
  getDb().prepare(`UPDATE ai_providers SET ${sets} WHERE id = ?`).run(...values, id);
}

function deleteAiProvider(id) {
  getDb().prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
}

// ========== AI 对话历史 ==========

function addAiChat(userId, role, content, providerId, sessionId) {
  getDb().prepare('INSERT INTO ai_chats (user_id, session_id, role, content, provider_id) VALUES (?, ?, ?, ?, ?)').run(userId, sessionId || 'default', role, content, providerId || null);
  // 更新会话时间
  if (sessionId) {
    getDb().prepare("UPDATE ai_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  }
}

function getAiChatHistory(userId, limit = 20, sessionId) {
  if (sessionId) {
    return getDb().prepare('SELECT * FROM ai_chats WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, sessionId, limit).reverse();
  }
  return getDb().prepare('SELECT * FROM ai_chats WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit).reverse();
}

function clearAiChatHistory(userId, sessionId) {
  if (sessionId) {
    getDb().prepare('DELETE FROM ai_chats WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
    return;
  }
  getDb().prepare('DELETE FROM ai_chats WHERE user_id = ?').run(userId);
}

// ========== AI 会话管理 ==========

function createAiSession(userId, sessionId, title) {
  getDb().prepare('INSERT INTO ai_sessions (id, user_id, title) VALUES (?, ?, ?)').run(sessionId, userId, title || '新对话');
  return { id: sessionId, user_id: userId, title: title || '新对话' };
}

function getAiSessions(userId) {
  return getDb().prepare('SELECT * FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

function getAiSessionById(sessionId) {
  return getDb().prepare('SELECT * FROM ai_sessions WHERE id = ?').get(sessionId);
}

function updateAiSessionTitle(sessionId, title) {
  getDb().prepare("UPDATE ai_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, sessionId);
}

function deleteAiSession(sessionId, userId) {
  getDb().prepare('DELETE FROM ai_chats WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
  getDb().prepare('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
}

// ========== 订阅访问记录 ==========

function logSubAccess(userId, ip, ua) {
  getDb().prepare('INSERT INTO sub_access_log (user_id, ip, ua) VALUES (?, ?, ?)').run(userId, ip, ua || '');
  // 清理30天前的记录
  getDb().prepare("DELETE FROM sub_access_log WHERE created_at < datetime('now', '-30 days')").run();
}

function getSubAccessIPs(userId, hours = 24) {
  return getDb().prepare(`
    SELECT ip, COUNT(*) as count, MAX(created_at) as last_access
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ip ORDER BY count DESC
  `).all(userId, hours);
}

function getSubAbuseUsers(hours = 24, minIPs = 3) {
  return getDb().prepare(`
    SELECT user_id, COUNT(DISTINCT ip) as ip_count, GROUP_CONCAT(DISTINCT ip) as ips
    FROM sub_access_log
    WHERE created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY user_id HAVING ip_count >= ?
    ORDER BY ip_count DESC
  `).all(hours, minIPs);
}

// 订阅访问统计 - 按用户聚合
function getSubAccessStats(hours = 24, limit = 50, offset = 0, onlyHigh = false, sort = 'count') {
  const orderMap = { count: 'pull_count DESC', ip: 'ip_count DESC', last: 'last_access DESC' };
  const orderBy = orderMap[sort] || orderMap.count;

  // 先查总数
  const baseWhere = `WHERE created_at > datetime('now', '-' || @hours || ' hours')`;
  const havingClause = onlyHigh
    ? 'HAVING COUNT(*) > 100 OR COUNT(DISTINCT ip) > 8'
    : '';

  const countRow = getDb().prepare(`
    SELECT COUNT(*) as total FROM (
      SELECT user_id FROM sub_access_log ${baseWhere}
      GROUP BY user_id ${havingClause}
    )
  `).get({ hours });

  const rows = getDb().prepare(`
    SELECT
      user_id,
      COUNT(*) as pull_count,
      COUNT(DISTINCT ip) as ip_count,
      MAX(created_at) as last_access,
      ROUND((@hours * 3600.0) / MAX(COUNT(*), 1), 1) as avg_interval_sec
    FROM sub_access_log ${baseWhere}
    GROUP BY user_id ${havingClause}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all({ hours, limit, offset });

  const data = rows.map(r => {
    const user = getUserById(r.user_id);
    const risk = (r.pull_count > 100 || r.ip_count > 8) ? 'high'
      : (r.pull_count >= 30 || r.ip_count >= 4) ? 'mid' : 'low';
    return { ...r, username: user?.username || '未知', risk_level: risk };
  });

  return { total: countRow.total, data };
}

// 订阅访问统计 - 用户详情
function getSubAccessUserDetail(userId, hours = 24) {
  const ips = getDb().prepare(`
    SELECT ip, COUNT(*) as count, MAX(created_at) as last_access
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ip ORDER BY count DESC
  `).all(userId, hours);

  const uas = getDb().prepare(`
    SELECT ua, COUNT(*) as count
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ua ORDER BY count DESC LIMIT 10
  `).all(userId, hours);

  const timeline = getDb().prepare(`
    SELECT created_at as time, ip, ua
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    ORDER BY created_at DESC LIMIT 20
  `).all(userId, hours);

  return { ips, uas, timeline };
}

// ========== AI 运营日记 ==========

function addDiaryEntry(content, mood = '🐱', category = 'ops') {
  return getDb().prepare(
    'INSERT INTO ops_diary (content, mood, category) VALUES (?, ?, ?)'
  ).run(content, mood, category);
}

function getDiaryEntries(limit = 50, offset = 0) {
  const total = getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const rows = getDb().prepare(
    'SELECT * FROM ops_diary ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return { rows, total, pages: Math.ceil(total / limit) };
}

function getDiaryStats() {
  const total = getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const firstEntry = getDb().prepare('SELECT created_at FROM ops_diary ORDER BY created_at ASC LIMIT 1').get();
  const todayCount = getDb().prepare(
    "SELECT COUNT(*) as c FROM ops_diary WHERE date(created_at) = date('now')"
  ).get().c;
  return { total, todayCount, firstEntry: firstEntry?.created_at || null };
}

module.exports = {
  getDb, findOrCreateUser, getUserBySubToken, getUserById, getUserCount, getAllUsers,
  blockUser, setUserTrafficLimit, isTrafficExceeded, freezeUser, unfreezeUser, autoFreezeInactiveUsers, resetSubToken,
  isInWhitelist, getWhitelist, addToWhitelist, removeFromWhitelist,
  isInRegisterWhitelist, getRegisterWhitelist, addToRegisterWhitelist, removeFromRegisterWhitelist,
  getAllNodes, getNodeById, addNode, updateNode, deleteNode, updateNodeAfterRotation,
  getUserNodeUuid, getUserAllNodeUuids, getNodeAllUserUuids,
  ensureAllUsersHaveUuid, ensureUserHasAllNodeUuids, rotateAllUserNodeUuids, rotateUserNodeUuidsByNodeIds,
  recordTraffic, getUserTraffic, getAllUsersTraffic, getNodeTraffic, getGlobalTraffic, getTodayTraffic, getUsersTrafficByRange, getNodesTrafficByRange,
  addAuditLog, getAuditLogs, clearAuditLogs,
  getSetting, setSetting,
  getAwsAccounts, getAwsAccountById, addAwsAccount, updateAwsAccount, deleteAwsAccount,
  getAllAiProviders, getEnabledAiProviders, getAiProviderById, addAiProvider, updateAiProvider, deleteAiProvider,
  addAiChat, getAiChatHistory, clearAiChatHistory,
  createAiSession, getAiSessions, getAiSessionById, updateAiSessionTitle, deleteAiSession,
  logSubAccess, getSubAccessIPs, getSubAbuseUsers, getSubAccessStats, getSubAccessUserDetail,
  addDiagnosis, updateDiagnosis, getDiagnosis, getAllDiagnoses, clearDiagnoses,
  addDiaryEntry, getDiaryEntries, getDiaryStats
};
