const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../../services/database');
const agentWs = require('../../services/agent-ws');

function parseIntId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const router = express.Router();

router.get('/agents', (req, res) => {
  res.json({ agents: agentWs.getConnectedAgents() });
});

router.post('/agents/:nodeId/command', async (req, res) => {
  const nodeId = parseIntId(req.params.nodeId);
  if (!nodeId) return res.status(400).json({ error: '参数错误' });
  const command = req.body;
  if (!command || !command.type) return res.status(400).json({ error: '缺少 command.type' });
  const result = await agentWs.sendCommand(nodeId, command);
  db.addAuditLog(req.user.id, 'agent_command', `节点#${nodeId} 指令: ${command.type}`, req.ip);
  res.json(result);
});

router.post('/agents/update-all', async (req, res) => {
  const agents = agentWs.getConnectedAgents();
  if (agents.length === 0) return res.json({ ok: true, results: [], message: '无在线 Agent' });
  const results = await Promise.all(agents.map(async (a) => {
    const r = await agentWs.sendCommand(a.nodeId, { type: 'self_update' });
    return { nodeId: a.nodeId, name: a.nodeName, success: r.success, error: r.error };
  }));
  db.addAuditLog(req.user.id, 'agent_update_all', `批量更新 Agent: ${agents.length} 个`, req.ip);
  res.json({ ok: true, results });
});

router.post('/agent-token/regenerate', (req, res) => {
  const nodes = db.getAllNodes();
  for (const node of nodes) {
    db.updateNode(node.id, { agent_token: uuidv4() });
  }
  const globalToken = uuidv4();
  db.setSetting('agent_token', globalToken);
  db.addAuditLog(req.user.id, 'agent_token_regen', `重新生成所有节点 Agent Token (${nodes.length} 个)`, req.ip);
  res.json({ token: globalToken, nodesUpdated: nodes.length });
});

module.exports = router;
