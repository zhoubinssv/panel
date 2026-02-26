let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

function addDiagnosis(nodeId, diagInfo) {
  return _getDb().prepare('INSERT INTO ops_diagnosis (node_id, diag_info) VALUES (?, ?)').run(nodeId, diagInfo);
}

function updateDiagnosis(id, fields) {
  const allowed = ['status','ai_analysis','fix_commands','fix_result','resolved_at'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  _getDb().prepare(`UPDATE ops_diagnosis SET ${sets} WHERE id = ?`).run(...Object.values(safe), id);
}

function getDiagnosis(id) {
  return _getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id WHERE d.id = ?').get(id);
}

function clearDiagnoses() {
  _getDb().prepare('DELETE FROM ops_diagnosis').run();
}

function getAllDiagnoses(limit = 20) {
  return _getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id ORDER BY d.created_at DESC LIMIT ?').all(limit);
}

// AI 运营日记
function addDiaryEntry(content, mood = '🐱', category = 'ops') {
  return _getDb().prepare(
    'INSERT INTO ops_diary (content, mood, category, created_at) VALUES (?, ?, ?, datetime("now", "localtime"))'
  ).run(content, mood, category);
}

function getDiaryEntries(limit = 50, offset = 0) {
  const total = _getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const rows = _getDb().prepare(
    'SELECT * FROM ops_diary ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return { rows, total, pages: Math.ceil(total / limit) };
}

function getDiaryStats() {
  const total = _getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const firstEntry = _getDb().prepare('SELECT created_at FROM ops_diary ORDER BY created_at ASC LIMIT 1').get();
  const todayCount = _getDb().prepare(
    "SELECT COUNT(*) as c FROM ops_diary WHERE date(created_at) = date('now')"
  ).get().c;
  return { total, todayCount, firstEntry: firstEntry?.created_at || null };
}

module.exports = {
  init,
  addDiagnosis, updateDiagnosis, getDiagnosis, getAllDiagnoses, clearDiagnoses,
  addDiaryEntry, getDiaryEntries, getDiaryStats
};
