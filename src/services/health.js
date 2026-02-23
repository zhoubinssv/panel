const net = require('net');
const { NodeSSH } = require('node-ssh');
const db = require('./database');

// 国内检测目标（TCP 检测，比 ICMP 更准）
const CN_TARGETS = [
  { host: '114.114.114.114', port: 53 },   // 114 DNS
  { host: '223.5.5.5', port: 53 },          // 阿里 DNS
  { host: '180.76.76.76', port: 53 },       // 百度 DNS
];

// TCP 端口探测（本地检测服务是否存活）
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
  // 没有 SSH 信息的节点（如家宽手动添加的）跳过反向检测
  if (!node.ssh_password && !node.ssh_key_path) return null;

  const ssh = new NodeSSH();
  try {
    const connectOpts = {
      host: node.ssh_host || node.host,
      port: node.ssh_port || 22,
      username: node.ssh_user || 'root',
      readyTimeout: 10000,
    };
    if (node.ssh_key_path) {
      connectOpts.privateKeyPath = node.ssh_key_path;
    } else if (node.ssh_password) {
      connectOpts.password = node.ssh_password;
    }

    await ssh.connect(connectOpts);

    // 用 bash 的 /dev/tcp 做 TCP 探测，不依赖额外工具
    // 测试 3 个国内 DNS，有 2 个通就算正常
    const result = await ssh.execCommand(`
      ok=0
      for target in "220.202.155.242 80" "114.114.114.114 53" "223.5.5.5 53"; do
        set -- $target
        timeout 3 bash -c "echo >/dev/tcp/$1/$2" 2>/dev/null && ok=$((ok+1))
      done
      echo $ok
    `, { execOptions: { timeout: 20000 } });

    const passCount = parseInt(result.stdout.trim()) || 0;
    return passCount >= 2; // 至少 2/3 通过
  } catch (err) {
    console.error(`[反向检测] ${node.name} SSH 连接失败: ${err.message}`);
    return null; // SSH 连不上，无法判断
  } finally {
    ssh.dispose();
  }
}

// 综合检测单个节点
async function checkNode(node) {
  // 1. 本地检测服务是否存活
  const serviceAlive = await checkPort(node.host, node.port);

  // 2. 反向检测国内连通性
  const cnReachable = await checkCNReachability(node);

  let status, remark;
  if (!serviceAlive) {
    status = 0;
    remark = '🔴 服务离线';
  } else if (cnReachable === false) {
    status = 0;
    remark = '🧱 疑似被墙';
  } else if (cnReachable === null && serviceAlive) {
    // SSH 连不上但服务端口通，可能只是 SSH 问题
    status = 1;
    remark = '';
  } else {
    status = 1;
    remark = '';
  }

  return { id: node.id, name: node.name, serviceAlive, cnReachable, status, remark };
}

// 检测所有节点并更新状态
async function checkAllNodes() {
  const nodes = db.getAllNodes();
  const toCheck = nodes.filter(n => !n.remark || !n.remark.includes('部署中'));

  console.log(`[健康检测] 开始检测 ${toCheck.length} 个节点...`);

  // 并发检测（最多 5 个同时）
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
    const batch = toCheck.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(node => checkNode(node)));
    results.push(...batchResults);
  }

  const { notify } = require('./notify');
  for (const result of results) {
    const current = db.getNodeById(result.id);
    if (!current) continue;

    if (result.status !== current.is_active || (result.remark && result.remark !== current.remark)) {
      db.updateNode(result.id, { is_active: result.status, remark: result.remark });
      if (!result.status && current.is_active) {
        console.log(`[健康检测] ${result.name} → ${result.remark}`);
        notify.nodeDown(result.name + (result.remark ? ' ' + result.remark : ''));
        // 自动修复流程
        autoRepair(current).catch(e => console.error('[自动修复]', e.message));
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

// 自动修复流程：重启 xray → 仍不通则 SSH 收集诊断 → AI 分析 → 存 DB + TG 通知
async function autoRepair(node) {
  if (!node.ssh_password && !node.ssh_key_path) return;
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  const connectOpts = {
    host: node.ssh_host || node.host, port: node.ssh_port || 22,
    username: node.ssh_user || 'root', readyTimeout: 10000
  };
  if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
  else connectOpts.password = node.ssh_password;

  const log = [`📍 节点: ${node.name} (${node.host}:${node.port})`, `⏰ 时间: ${new Date().toLocaleString('zh-CN')}`];

  try {
    log.push('', '🔌 Step 1: SSH 连接节点...');
    await ssh.connect(connectOpts);
    log.push('✅ SSH 连接成功');

    // Step 1: 尝试重启 xray
    log.push('', '🔄 Step 2: 尝试重启 xray...');
    const restartResult = await ssh.execCommand('systemctl restart xray 2>&1');
    log.push(restartResult.stdout || restartResult.stderr || '(无输出)');
    await new Promise(r => setTimeout(r, 3000));

    const alive = await checkPort(node.host, node.port);
    if (alive) {
      log.push('✅ 重启后端口恢复正常');
      db.updateNode(node.id, { is_active: 1, remark: '' });
      const { notify } = require('./notify');
      notify.nodeUp(node.name + '（自动重启恢复）').catch(() => {});
      return;
    }
    log.push('❌ 重启后端口仍不通');

    // Step 2: 收集诊断信息
    log.push('', '📋 Step 3: 收集诊断信息...');
    const cmds = [
      'systemctl status xray 2>&1 | tail -20',
      'journalctl -u xray --no-pager -n 30 2>&1',
      `ss -tlnp | grep -E ':${node.port}|xray'`,
      'df -h / | tail -1',
      'free -m | head -2',
      'cat /usr/local/etc/xray/config.json 2>&1 | head -50'
    ];
    for (const cmd of cmds) {
      const r = await ssh.execCommand(cmd, { execOptions: { timeout: 10000 } });
      log.push(`\n$ ${cmd}`, r.stdout || r.stderr || '(empty)');
    }

    const diagInfo = log.join('\n');
    const result = db.addDiagnosis(node.id, diagInfo);
    const diagId = result.lastInsertRowid;

    // Step 3: AI 分析
    const opsAi = require('./ops-ai');
    const cfg = opsAi.getOpsConfig();
    if (!cfg) {
      db.updateDiagnosis(diagId, { status: 'no_ai', ai_analysis: '运维 AI 未配置' });
      const { notify } = require('./notify');
      notify.ops(`⚠️ 节点 ${node.name} 异常，自动重启失败，运维 AI 未配置，请手动排查`);
      return;
    }

    db.updateDiagnosis(diagId, { ai_analysis: `⏳ 正在调用 ${cfg.type.toUpperCase()} 模型 ${cfg.model} 分析中...` });

    const aiResult = await opsAi.analyze(diagInfo);
    if (aiResult) {
      db.updateDiagnosis(diagId, {
        status: 'analyzed',
        ai_analysis: `🤖 模型: ${cfg.type.toUpperCase()} / ${cfg.model}\n\n${aiResult.analysis}`,
        fix_commands: JSON.stringify(aiResult.commands)
      });
      const { notify } = require('./notify');
      notify.ops(`🔧 节点 ${node.name} 异常，AI (${cfg.model}) 已分析：\n\n${aiResult.analysis}\n\n修复命令 ${aiResult.commands.length} 条，请到后台运维 Tab 确认执行`);
    } else {
      db.updateDiagnosis(diagId, { status: 'no_ai', ai_analysis: `❌ 模型 ${cfg.model} 调用失败` });
      const { notify: n2 } = require('./notify');
      n2.ops(`⚠️ 节点 ${node.name} 异常，AI (${cfg.model}) 调用失败，请手动排查`);
    }
  } catch (e) {
    console.error(`[自动修复] ${node.name} 失败:`, e.message);
    log.push('', `❌ 错误: ${e.message}`);
    const result = db.addDiagnosis(node.id, log.join('\n'));
    db.updateDiagnosis(result.lastInsertRowid, { status: 'no_ai', ai_analysis: `SSH 连接失败: ${e.message}` });
  } finally {
    ssh.dispose();
  }
}

module.exports = { checkPort, checkNode, checkAllNodes, autoRepair };
