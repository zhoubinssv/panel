let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

function addAuditLog(userId, action, detail, ip) {
  _getDb().prepare("INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, datetime('now', 'localtime'))").run(userId, action, detail, ip);
}

function getAuditLogs(limit = 50, offset = 0, type = 'all') {
  const where = type === 'system' ? "WHERE a.ip = 'system'" : type === 'user' ? "WHERE a.ip != 'system'" : '';
  const rows = _getDb().prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = _getDb().prepare(`SELECT COUNT(*) as c FROM audit_log a ${where}`).get().c;
  return { rows, total };
}

function clearAuditLogs() {
  _getDb().prepare('DELETE FROM audit_log').run();
}

function getSetting(key) {
  const row = _getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  _getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// 白名单操作（节点访问白名单）
function isInWhitelist(nodeloc_id) {
  return !!_getDb().prepare('SELECT 1 FROM whitelist WHERE nodeloc_id = ?').get(nodeloc_id);
}

function getWhitelist() {
  return _getDb().prepare(`
    SELECT w.*, u.username, u.name FROM whitelist w
    LEFT JOIN users u ON w.nodeloc_id = u.nodeloc_id
    ORDER BY w.added_at DESC
  `).all();
}

function addToWhitelist(nodeloc_id) {
  _getDb().prepare('INSERT OR IGNORE INTO whitelist (nodeloc_id) VALUES (?)').run(nodeloc_id);
}

function removeFromWhitelist(nodeloc_id) {
  _getDb().prepare('DELETE FROM whitelist WHERE nodeloc_id = ?').run(nodeloc_id);
}

// 注册白名单
function isInRegisterWhitelist(username) {
  return !!_getDb().prepare('SELECT 1 FROM register_whitelist WHERE username = ?').get(username);
}

function getRegisterWhitelist() {
  return _getDb().prepare('SELECT * FROM register_whitelist ORDER BY added_at DESC').all();
}

function addToRegisterWhitelist(username) {
  _getDb().prepare('INSERT OR IGNORE INTO register_whitelist (username) VALUES (?)').run(username.trim());
}

function removeFromRegisterWhitelist(username) {
  _getDb().prepare('DELETE FROM register_whitelist WHERE username = ?').run(username.trim());
}

module.exports = {
  init,
  addAuditLog, getAuditLogs, clearAuditLogs,
  getSetting, setSetting,
  isInWhitelist, getWhitelist, addToWhitelist, removeFromWhitelist,
  isInRegisterWhitelist, getRegisterWhitelist, addToRegisterWhitelist, removeFromRegisterWhitelist
};
