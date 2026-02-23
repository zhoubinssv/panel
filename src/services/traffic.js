const { NodeSSH } = require('node-ssh');
const db = require('./database');

// 从单个节点采集流量数据
async function collectNodeTraffic(node) {
  if (!node.ssh_password && !node.ssh_key_path) return [];

  const ssh = new NodeSSH();
  try {
    const connectOpts = {
      host: node.ssh_host || node.host,
      port: node.ssh_port || 22,
      username: node.ssh_user || 'root',
      readyTimeout: 10000,
    };
    if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
    else if (node.ssh_password) connectOpts.password = node.ssh_password;

    await ssh.connect(connectOpts);

    // 通过 xray api 查询所有用户流量，然后重置计数器
    const cmd = `
      # 查询所有用户流量统计
      xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" 2>/dev/null || echo "API_ERROR"
    `;

    const result = await ssh.execCommand(cmd, { execOptions: { timeout: 15000 } });

    if (result.stdout.includes('API_ERROR') || !result.stdout.trim()) {
      return [];
    }

    // 解析 xray stats 输出
    // 格式: { "stat": [ { "name": "user>>>user-1@panel>>>traffic>>>uplink", "value": "12345" }, ... ] }
    const records = [];
    try {
      const data = JSON.parse(result.stdout);
      if (data.stat) {
        for (const stat of data.stat) {
          // name 格式: user>>>user-{userId}@panel>>>traffic>>>uplink/downlink
          const match = stat.name.match(/user>>>user-(\d+)@panel>>>traffic>>>(uplink|downlink)/);
          if (match) {
            const userId = parseInt(match[1]);
            const direction = match[2];
            const value = parseInt(stat.value) || 0;
            if (value > 0) {
              records.push({ userId, direction, value });
            }
          }
        }
      }
    } catch (e) {
      // 可能不是 JSON，尝试按行解析
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/user-(\d+)@panel>>>traffic>>>(uplink|downlink).*?"(\d+)"/);
        if (match) {
          records.push({
            userId: parseInt(match[1]),
            direction: match[2],
            value: parseInt(match[3]) || 0
          });
        }
      }
    }

    // 查询完后重置计数器
    if (records.length > 0) {
      await ssh.execCommand('xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset 2>/dev/null');
    }

    return records;
  } catch (err) {
    console.error(`[流量采集] ${node.name} 失败: ${err.message}`);
    return [];
  } finally {
    ssh.dispose();
  }
}

// 采集所有节点的流量并写入数据库
async function collectAllTraffic() {
  const nodes = db.getAllNodes(true);
  console.log(`[流量采集] 开始采集 ${nodes.length} 个节点...`);

  let totalRecords = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < nodes.length; i += CONCURRENCY) {
    const batch = nodes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(node => collectNodeTraffic(node).then(records => ({ node, records }))));

    for (const { node, records } of batchResults) {
      const userTraffic = {};
      for (const r of records) {
        if (!userTraffic[r.userId]) userTraffic[r.userId] = { up: 0, down: 0 };
        if (r.direction === 'uplink') userTraffic[r.userId].up += r.value;
        else userTraffic[r.userId].down += r.value;
      }
      for (const [userId, traffic] of Object.entries(userTraffic)) {
        if (traffic.up > 0 || traffic.down > 0) {
          db.recordTraffic(parseInt(userId), node.id, traffic.up, traffic.down);
          totalRecords++;
        }
      }
    }
  }

  console.log(`[流量采集] 完成 共 ${totalRecords} 条记录`);

  // 检测日流量超标（10GB）
  try {
    const { notify } = require('./notify');
    const today = new Date().toISOString().slice(0, 10);
    const todayTraffic = db.getDb().prepare(`
      SELECT t.user_id, u.username, SUM(t.uplink) as total_up, SUM(t.downlink) as total_down
      FROM traffic_daily t JOIN users u ON t.user_id = u.id
      WHERE t.date = ? GROUP BY t.user_id HAVING (total_up + total_down) >= ?
    `).all(today, 10 * 1073741824);
    for (const u of todayTraffic) {
      const cacheKey = `traffic_notified_${u.user_id}_${today}`;
      if (!global[cacheKey]) {
        global[cacheKey] = true;
        notify.trafficExceed(u.username, u.total_up + u.total_down);
      }
    }
  } catch(e) { console.error('[流量超标检测]', e.message); }

  return totalRecords;
}

// 格式化流量显示
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

module.exports = { collectNodeTraffic, collectAllTraffic, formatBytes };
