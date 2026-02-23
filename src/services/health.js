const net = require('net');
const { NodeSSH } = require('node-ssh');
const db = require('./database');

// TCP 端口探测
function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => { resolved = true; socket.destroy(); resolve(true); });
    socket.on('timeout', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.on('error', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.connect(port, host);
  });
}

// 从节点 SSH 反向检测国内连通性
async function checkCNReachability(node) {
  if (!node.ssh_password && !node.ssh_key_path) return null;

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

    const result = await ssh.execCommand(`
      ok=0
      for target in "220.202.155.242 80" "114.114.114.114 53" "223.5.5.5 53"; do
        set -- $target
        timeout 3 bash -c "echo >/dev/tcp/$1/$2" 2>/dev/null && ok=$((ok+1))
      done
      echo $ok
    `, { execOptions: { timeout: 20000 } });

    const passCount = parseInt(result.stdout.trim()) || 0;
    return passCount >= 2;
  } catch (err) {
    console.error(`[反向检测] ${node.name} SSH 连接失败: ${err.message}`);
    return null;
  } finally {
    ssh.dispose();
  }
}

// 综合检测单个节点
async function checkNode(node) {
  const serviceAlive = await checkPort(node.host, node.port);
  const cnReachable = await checkCNReachability(node);

  let status, remark;
  if (!serviceAlive) {
    status = 0;
    remark = '🔴 服务离线';
  } else if (cnReachable === false) {
    status = 0;
    remark = '🧱 疑似被墙';
  } else if (cnReachable === null && serviceAlive) {
    status = 1;
    remark = '';
  } else {
    status = 1;
    remark = '';
  }

  return { id: node.id, name: node.name, serviceAlive, cnReachable, status, remark };
}

// 检测所有节点并更新状态（只检测 + 通知，修复交给小乖）
async function checkAllNodes() {
  const nodes = db.getAllNodes();
  const toCheck = nodes.filter(n => !n.remark || !n.remark.includes('部署中'));

  console.log(`[健康检测] 开始检测 ${toCheck.length} 个节点...`);

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
    const batch = toCheck.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(node => checkNode(node)));
    results.push(...batchResults);
  }

  const { notify, send } = require('./notify');
  for (const result of results) {
    const current = db.getNodeById(result.id);
    if (!current) continue;

    // 手动节点：连续失败达到阈值自动移除并 TG 通知
    if (current.is_manual) {
      const nextFailCount = result.status === 0 ? ((current.fail_count || 0) + 1) : 0;
      db.updateNode(result.id, { fail_count: nextFailCount });
      if (result.status === 0 && nextFailCount >= 3) {
        const detail = `${result.name} (${current.host}:${current.port}) 连续 ${nextFailCount} 次检测失败，已自动移除`;
        console.log(`[健康检测] [手动节点自动移除] ${detail}`);
        db.addAuditLog(null, 'node_auto_remove_manual', detail, 'system');
        db.deleteNode(result.id);
        send(`🗑️ <b>手动节点已自动移除</b>\n节点: ${result.name}\n地址: ${current.host}:${current.port}\n原因: 连续 ${nextFailCount} 次检测失败 (${result.remark || '不可达'})\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).catch(() => {});
        continue;
      }
    }

    if (result.status !== current.is_active || (result.remark && result.remark !== current.remark)) {
      db.updateNode(result.id, { is_active: result.status, remark: result.remark });
      if (!result.status && current.is_active) {
        console.log(`[健康检测] ${result.name} → ${result.remark}`);

        // 被墙且已绑定 AWS：自动换 IP
        if (result.remark && result.remark.includes('被墙') && current.aws_instance_id) {
          try {
            notify.ops(`🧱 <b>检测到疑似被墙</b>\n节点: ${result.name}\n动作: 自动换 IP 开始`);
            const aws = require('./aws');
            const swap = await aws.swapNodeIp(current, current.aws_instance_id, current.aws_type, current.aws_region, current.aws_account_id);
            if (swap.success) {
              notify.ops(`✅ <b>自动换 IP 成功</b>\n节点: ${result.name}\nIP: ${swap.oldIp || '未知'} → ${swap.newIp}`);
            } else {
              notify.ops(`❌ <b>自动换 IP 失败</b>\n节点: ${result.name}\n原因: ${swap.error || '未知错误'}`);
            }
          } catch (e) {
            notify.ops(`❌ <b>自动换 IP 异常</b>\n节点: ${result.name}\n原因: ${e.message}`);
          }
        } else {
          // 未绑定 AWS：仅通知
          notify.nodeDown(result.name + (result.remark ? ' ' + result.remark : ''));
        }
      } else if (result.status && !current.is_active) {
        console.log(`[健康检测] ${result.name} 恢复在线 🟢`);
        notify.nodeUp(result.name);
      }
    }
    db.updateNode(result.id, { last_check: new Date().toISOString().replace('T', ' ').substring(0, 19) });
  }

  const online = results.filter(r => r.status === 1).length;
  const offline = results.filter(r => r.status === 0).length;
  console.log(`[健康检测] 完成 在线:${online} 异常:${offline}`);
  return results;
}

module.exports = { checkPort, checkNode, checkAllNodes };
