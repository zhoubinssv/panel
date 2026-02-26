const express = require('express');
const router = express.Router();
const db = require('../../services/database');
const { v4: uuidv4 } = require('uuid');

// 获取所有捐赠列表
router.get('/donations', (req, res) => {
  const d = db.getDb();
  const donations = d.prepare(`
    SELECT nd.*, u.username, u.name as user_name
    FROM node_donations nd
    JOIN users u ON nd.user_id = u.id
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

  try {
    // 检测地区
    let region = donation.region || '';
    if (!region && donation.server_ip) {
      try {
        const { detectRegion } = require('../../services/deploy');
        region = await detectRegion(donation.server_ip);
      } catch {}
    }

    // 查捐赠者用户名
    const donor = d.prepare('SELECT username FROM users WHERE id = ?').get(donation.user_id);
    const donorName = donor ? donor.username : `用户${donation.user_id}`;

    // 自动生成节点名：国旗+城市+用户名+捐赠
    const nodeName = name || (region ? `${region}-${donorName}捐赠` : `${donorName}捐赠`);

    // 创建节点记录
    const agentToken = uuidv4();
    const nodeUuid = uuidv4();
    const nodeResult = d.prepare(`
      INSERT INTO nodes (name, host, port, uuid, is_active, agent_token, group_name, remark)
      VALUES (?, ?, 443, ?, 1, ?, ?, '🎁 捐赠节点')
    `).run(nodeName, donation.server_ip, nodeUuid, agentToken, group_name || '捐赠节点');

    const nodeId = nodeResult.lastInsertRowid;

    // 更新捐赠记录
    d.prepare(`
      UPDATE node_donations SET status = 'online', node_id = ?, region = ?, approved_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(nodeId, region, donation.id);

    // 给所有符合条件的用户分配 UUID
    const uuidRepo = require('../../services/repos/uuidRepo');
    uuidRepo.ensureAllUsersHaveUuid(nodeId);

    // 标记捐赠者
    d.prepare('UPDATE users SET is_donor = 1 WHERE id = ?').run(donation.user_id);

    db.addAuditLog(null, 'donate_approve', `审核通过捐赠节点: ${nodeName} (${donation.server_ip}), 捐赠者: ${donorName}`, '');

    res.json({ ok: true, nodeId, agentToken });
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
