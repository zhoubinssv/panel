const { encrypt, decrypt } = require('../../utils/crypto');

let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

function decryptProvider(p) {
  if (!p) return p;
  p.api_key = decrypt(p.api_key);
  return p;
}

function getAllAiProviders() {
  return _getDb().prepare('SELECT * FROM ai_providers ORDER BY priority DESC, id ASC').all().map(decryptProvider);
}

function getEnabledAiProviders() {
  return _getDb().prepare('SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY priority DESC, id ASC').all().map(decryptProvider);
}

function getAiProviderById(id) {
  return decryptProvider(_getDb().prepare('SELECT * FROM ai_providers WHERE id = ?').get(id));
}

function addAiProvider(provider) {
  return _getDb().prepare(`
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
  _getDb().prepare(`UPDATE ai_providers SET ${sets} WHERE id = ?`).run(...values, id);
}

function deleteAiProvider(id) {
  _getDb().prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
}

// AI 对话历史
function addAiChat(userId, role, content, providerId, sessionId) {
  _getDb().prepare('INSERT INTO ai_chats (user_id, session_id, role, content, provider_id) VALUES (?, ?, ?, ?, ?)').run(userId, sessionId || 'default', role, content, providerId || null);
  if (sessionId) {
    _getDb().prepare("UPDATE ai_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  }
}

function getAiChatHistory(userId, limit = 20, sessionId) {
  if (sessionId) {
    return _getDb().prepare('SELECT * FROM ai_chats WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, sessionId, limit).reverse();
  }
  return _getDb().prepare('SELECT * FROM ai_chats WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit).reverse();
}

function clearAiChatHistory(userId, sessionId) {
  if (sessionId) {
    _getDb().prepare('DELETE FROM ai_chats WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
    return;
  }
  _getDb().prepare('DELETE FROM ai_chats WHERE user_id = ?').run(userId);
}

// AI 会话管理
function createAiSession(userId, sessionId, title) {
  _getDb().prepare('INSERT INTO ai_sessions (id, user_id, title) VALUES (?, ?, ?)').run(sessionId, userId, title || '新对话');
  return { id: sessionId, user_id: userId, title: title || '新对话' };
}

function getAiSessions(userId) {
  return _getDb().prepare('SELECT * FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

function getAiSessionById(sessionId) {
  return _getDb().prepare('SELECT * FROM ai_sessions WHERE id = ?').get(sessionId);
}

function updateAiSessionTitle(sessionId, title) {
  _getDb().prepare("UPDATE ai_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, sessionId);
}

function deleteAiSession(sessionId, userId) {
  _getDb().prepare('DELETE FROM ai_chats WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
  _getDb().prepare('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
}

module.exports = {
  init,
  getAllAiProviders, getEnabledAiProviders, getAiProviderById,
  addAiProvider, updateAiProvider, deleteAiProvider,
  addAiChat, getAiChatHistory, clearAiChatHistory,
  createAiSession, getAiSessions, getAiSessionById, updateAiSessionTitle, deleteAiSession
};
