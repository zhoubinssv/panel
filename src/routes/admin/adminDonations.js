const express = require('express');
const router = express.Router();
const db = require('../../services/database');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const deployService = require('../../services/deploy');
const uuidRepo = require('../../services/repos/uuidRepo');
const agentWs = require('../../services/agent-ws');

// 生成 Reality x25519 密钥对
function generateRealityKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return {
    realityPrivateKey: privRaw.toString('base64url'),
    realityPublicKey: pubRaw.toString('base64url'),
    realityShortId: crypto.randomBytes(4).toString('hex'),
  };
}

// 获取所有捐赠列表
router.get('/donations', (req, res) => {
  const d = db.getDb();
  const donations = d.prepare(`
    SELECT nd.*, u.username, u.name as user_name, n.name as node_name, n.is_active as node_active
    FROM node_donations nd
    JOIN users u ON nd.user_id = u.id
    LEFT JOIN nodes n ON nd.node_id = n.id
    ORDER BY nd.created_at DESC
  `).all();
  res.json({ ok: true, donations });
});

// 审核通过 - 创建节点并部署
router.post('/donations/:id/approve', async (req, res) => {
  const d = db.getDb();
  const donation = d.prepare('SELECT * FROM node_donations WHERE id = ?').get(req.params.id);
  if (!donation) return res.json({ ok: false, error: '捐赠记录不存在' });
  if (donation.status === 'online') return res.json({ ok: false, error: '已审核通过' });

  const { name, group_name } = req.body;
  const protocolChoice = donation.protocol_choice || 'vless';

  try {
    // 检测地区
    let region = donation.region || '';
    if (!region && donation.server_ip) {
      try {
        const geo = await deployService.detectRegion(donation.server_ip);
        if (geo && geo.cityCN !== '未知') region = `${geo.emoji} ${geo.cityCN}`;
      } catch {}
    }

    // 查捐赠者用户名
    const donor = d.prepare('SELECT username, name FROM users WHERE id = ?').get(donation.user_id);
    const donorName = donor ? (donor.name || donor.username) : `用户${donation.user_id}`;

    const nodeIds = [];

    // ─── 根据协议选择创建节点 ───

    if (protocolChoice === 'vless' || protocolChoice === 'dual') {
      // 创建 VLESS (IPv4) 节点
      const vlessName = name || (region ? `${region}-${donorName}捐赠` : `${donorName}捐赠`);
      const vlessPort = 10000 + Math.floor(Math.random() * 50000);
      const vlessUuid = uuidv4();
      const vlessAgentToken = uuidv4();
      const vlessResult = d.prepare(`
        INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, is_active, agent_token, group_name, remark, is_donation)
        VALUES (?, ?, ?, ?, 'vless', 4, 1, ?, ?, '🎁 捐赠节点', 1)
      `).run(vlessName, donation.server_ip, vlessPort, vlessUuid, vlessAgentToken, group_name || '捐赠节点');
      const vlessNodeId = vlessResult.lastInsertRowid;
      nodeIds.push(vlessNodeId);

      // 生成 Reality 密钥
      const { realityPrivateKey, realityPublicKey, realityShortId } = generateRealityKeys();
      db.updateNode(vlessNodeId, { reality_private_key: realityPrivateKey, reality_public_key: realityPublicKey, reality_short_id: realityShortId, sni: 'www.microsoft.com' });

      uuidRepo.ensureAllUsersHaveUuid(vlessNodeId);
    }

    if (protocolChoice === 'ss' || protocolChoice === 'dual') {
      // 创建 SS (IPv6) 节点
      // 通过 Agent 检测 IPv6 地址
      let ipv6Addr = null;
      // 尝试从已连接的 Agent 获取 IPv6
      // 先找到 Agent 连接（用捐赠 token 查找）
      const connectedAgents = agentWs.getConnectedAgents();
      for (const agent of connectedAgents) {
        if (agent.ip === donation.server_ip) {
          try {
            const ipResult = await agentWs.sendCommand(agent.nodeId, {
              type: 'exec',
              command: "ip -6 addr show scope global | grep inet6 | head -1 | awk '{print $2}' | cut -d/ -f1"
            });
            if (ipResult.success && ipResult.data?.stdout?.trim()) {
              ipv6Addr = ipResult.data.stdout.trim();
            }
          } catch {}
          break;
        }
      }

      if (!ipv6Addr && protocolChoice === 'ss') {
        return res.json({ ok: false, error: '未检测到 IPv6 地址，无法部署 SS 节点。请确认服务器有公网 IPv6。' });
      }

      if (ipv6Addr) {
        const ssName = (protocolChoice === 'dual')
          ? (region ? `${region}-${donorName}捐赠-SS` : `${donorName}捐赠-SS`)
          : (name || (region ? `${region}-${donorName}捐赠` : `${donorName}捐赠`));
        const ssPort = 10000 + Math.floor(Math.random() * 50000);
        const ssPassword = uuidv4();
        const ssAgentToken = uuidv4();
        const ssResult = d.prepare(`
          INSERT INTO nodes (name, host, port, uuid, protocol, ip_version, ss_method, is_active, agent_token, group_name, remark, is_donation)
          VALUES (?, ?, ?, ?, 'ss', 6, 'aes-256-gcm', 1, ?, ?, '🎁 捐赠节点', 1)
        `).run(ssName, ipv6Addr, ssPort, ssPassword, ssAgentToken, group_name || '捐赠节点');
        const ssNodeId = ssResult.lastInsertRowid;
        nodeIds.push(ssNodeId);

        uuidRepo.ensureAllUsersHaveUuid(ssNodeId);
      } else if (protocolChoice === 'dual') {
        console.log(`[捐赠审核] ${donation.server_ip} 无 IPv6，跳过 SS 节点，仅部署 VLESS`);
      }
    }

    if (nodeIds.length === 0) {
      return res.json({ ok: false, error: '未创建任何节点' });
    }

    // 更新捐赠记录（绑定第一个节点）
    d.prepare(`
      UPDATE node_donations SET status = 'online', node_id = ?, region = ?, approved_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(nodeIds[0], region, donation.id);

    // 标记捐赠者
    d.prepare('UPDATE users SET is_donor = 1 WHERE id = ?').run(donation.user_id);

    const allNodeNames = nodeIds.map(id => db.getNodeById(id)?.name || id).join(', ');
    db.addAuditLog(null, 'donate_approve', `审核通过捐赠节点: ${allNodeNames} (${donation.server_ip}), 协议: ${protocolChoice}, 捐赠者: ${donorName}`, '');

    // 推送 Xray 配置到所有新建节点
    try {
      for (const nid of nodeIds) {
        const newNode = db.getNodeById(nid);
        const syncOk = await deployService.syncNodeConfig(newNode, db);
        console.log(`[捐赠审核] 配置推送 ${syncOk ? '成功' : '失败'}: ${newNode.name}`);
      }
    } catch (syncErr) {
      console.error(`[捐赠审核] 配置推送异常: ${syncErr.message}`);
    }

    res.json({ ok: true, nodeIds, protocolChoice });
  } catch (e) {
    console.error('[捐赠审核] 错误:', e);
    res.json({ ok: false, error: e.message });
  }
});

// 拒绝捐赠
router.post('/donations/:id/reject', (req, res) => {
  const d = db.getDb();
  const donation = d.prepare('SELECT * FROM node_donations WHERE id = ?').get(req.params.id);
  if (!donation) return res.json({ ok: false, error: '捐赠记录不存在' });

  d.prepare("UPDATE node_donations SET status = 'rejected' WHERE id = ?").run(req.params.id);
  db.addAuditLog(null, 'donate_reject', `拒绝捐赠: IP ${donation.server_ip}, 用户#${donation.user_id}`, '');
  res.json({ ok: true });
});

// 删除捐赠记录
router.delete('/donations/:id', (req, res) => {
  const d = db.getDb();
  d.prepare('DELETE FROM node_donations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
