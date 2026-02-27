let _getDb, _getUserById;

function init(deps) {
  _getDb = deps.getDb;
  _getUserById = deps.getUserById;
}

function logSubAccess(userId, ip, ua) {
  // 仅记录访问；历史清理由 app.js 的定时任务统一处理，避免高频订阅路径触发 DELETE
  _getDb().prepare("INSERT INTO sub_access_log (user_id, ip, ua, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))").run(userId, ip, ua || '');
}

function getSubAccessIPs(userId, hours = 24) {
  return _getDb().prepare(`
    SELECT ip, COUNT(*) as count, MAX(created_at) as last_access
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ip ORDER BY count DESC
  `).all(userId, hours);
}

function getSubAbuseUsers(hours = 24, minIPs = 3) {
  return _getDb().prepare(`
    SELECT user_id, COUNT(DISTINCT ip) as ip_count, GROUP_CONCAT(DISTINCT ip) as ips
    FROM sub_access_log
    WHERE created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY user_id HAVING ip_count >= ?
    ORDER BY ip_count DESC
  `).all(hours, minIPs);
}

function getSubAccessStats(hours = 24, limit = 50, offset = 0, onlyHigh = false, sort = 'count') {
  const orderMap = { count: 'pull_count DESC', ip: 'ip_count DESC', last: 'last_access DESC' };
  const orderBy = orderMap[sort] || orderMap.count;

  const baseWhere = `WHERE created_at > datetime('now', '-' || @hours || ' hours')`;
  const havingClause = onlyHigh ? 'HAVING COUNT(*) > 100 OR COUNT(DISTINCT ip) > 8' : '';

  const countRow = _getDb().prepare(`
    SELECT COUNT(*) as total FROM (
      SELECT user_id FROM sub_access_log ${baseWhere}
      GROUP BY user_id ${havingClause}
    )
  `).get({ hours });

  const rows = _getDb().prepare(`
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
    const user = _getUserById(r.user_id);
    const risk = (r.pull_count > 100 || r.ip_count > 8) ? 'high'
      : (r.pull_count >= 30 || r.ip_count >= 4) ? 'mid' : 'low';
    return { ...r, username: user?.username || '未知', risk_level: risk };
  });

  return { total: countRow.total, data };
}

function getSubAccessUserDetail(userId, hours = 24) {
  const ips = _getDb().prepare(`
    SELECT ip, COUNT(*) as count, MAX(created_at) as last_access
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ip ORDER BY count DESC
  `).all(userId, hours);

  const uas = _getDb().prepare(`
    SELECT ua, COUNT(*) as count
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    GROUP BY ua ORDER BY count DESC LIMIT 10
  `).all(userId, hours);

  const timeline = _getDb().prepare(`
    SELECT created_at as time, ip, ua
    FROM sub_access_log
    WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
    ORDER BY created_at DESC LIMIT 20
  `).all(userId, hours);

  return { ips, uas, timeline };
}

module.exports = {
  init,
  logSubAccess, getSubAccessIPs, getSubAbuseUsers, getSubAccessStats, getSubAccessUserDetail
};
