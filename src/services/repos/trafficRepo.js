let _getDb, _getUserById;

function init(deps) {
  _getDb = deps.getDb;
  _getUserById = deps.getUserById;
}

function recordTraffic(userId, nodeId, uplink, downlink) {
  _getDb().prepare('INSERT INTO traffic (user_id, node_id, uplink, downlink) VALUES (?, ?, ?, ?)').run(userId, nodeId, uplink, downlink);
  const today = new Date().toISOString().split('T')[0];
  _getDb().prepare(`
    INSERT INTO traffic_daily (user_id, node_id, date, uplink, downlink)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, node_id, date) DO UPDATE SET
      uplink = uplink + excluded.uplink,
      downlink = downlink + excluded.downlink
  `).run(userId, nodeId, today, uplink, downlink);
}

function getUserTraffic(userId) {
  return _getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE user_id = ?
  `).get(userId);
}

function getAllUsersTraffic(date, limit = 20, offset = 0) {
  const where = date ? 'AND t.date = ?' : '';
  const params = date ? [date, limit, offset] : [limit, offset];
  const rows = _getDb().prepare(`
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
  const total = _getDb().prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT u.id FROM users u
      LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
      GROUP BY u.id HAVING COALESCE(SUM(t.uplink),0) + COALESCE(SUM(t.downlink),0) > 0
    )
  `).get(...countParams).c;
  return { rows, total };
}

function getNodeTraffic(nodeId) {
  return _getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE node_id = ?
  `).get(nodeId);
}

function getGlobalTraffic() {
  return _getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily
  `).get();
}

function getTodayTraffic() {
  const today = new Date().toISOString().slice(0, 10);
  return _getDb().prepare(`
    SELECT COALESCE(SUM(uplink), 0) as total_up, COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily WHERE date = ?
  `).get(today);
}

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
  if (range === 'all') return { where: '', params: [] };
  // 支持具体日期 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(range)) return { where: 'AND t.date = ?', params: [range] };
  return { where: '', params: [] };
}

function getUsersTrafficByRange(range, limit = 20, offset = 0) {
  const { where, params } = _rangeDateCondition(range);
  const rows = _getDb().prepare(`
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
  const total = _getDb().prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT u.id FROM users u
      LEFT JOIN traffic_daily t ON u.id = t.user_id ${where}
      GROUP BY u.id HAVING COALESCE(SUM(t.uplink),0) + COALESCE(SUM(t.downlink),0) > 0
    )
  `).get(...params).c;
  return { rows, total };
}

function getNodesTrafficByRange(range) {
  const { where, params } = _rangeDateCondition(range);
  return _getDb().prepare(`
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

function getTrafficTrend(days = 30) {
  const d = new Date(); d.setDate(d.getDate() - days + 1);
  const startDate = d.toISOString().slice(0, 10);
  return _getDb().prepare(`
    SELECT date,
      COALESCE(SUM(uplink), 0) as total_up,
      COALESCE(SUM(downlink), 0) as total_down
    FROM traffic_daily
    WHERE date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(startDate);
}

module.exports = {
  init,
  recordTraffic, getUserTraffic, getAllUsersTraffic, getNodeTraffic,
  getGlobalTraffic, getTodayTraffic, getUsersTrafficByRange, getNodesTrafficByRange,
  getTrafficTrend
};
