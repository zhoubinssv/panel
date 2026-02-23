const express = require('express');
const db = require('../services/database');
const { buildVlessLink, generateV2raySubForUser, generateClashSubForUser, generateSingboxSubForUser, detectClient } = require('../utils/vless');
const { formatBytes } = require('../services/traffic');
const aiService = require('../services/ai');
const { requireAuth } = require('../middleware/auth');
const { aiLimiter, subLimiter } = require('../middleware/rateLimit');
const QRCode = require('qrcode');

const router = express.Router();

function getRealClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp).trim();

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();

  return req.ip;
}

// 首页 - 节点列表（每个用户看到自己的 UUID）
router.get('/', requireAuth, (req, res) => {
  const isVip = db.isInWhitelist(req.user.nodeloc_id);
  const nodes = db.getAllNodes(true).filter(n => isVip || req.user.trust_level >= (n.min_level || 0));
  const user = req.user;
  db.ensureUserHasAllNodeUuids(user.id);

  const traffic = db.getUserTraffic(user.id);
  const globalTraffic = db.getGlobalTraffic();

  const userNodes = nodes.map(n => {
    const userUuid = db.getUserNodeUuid(user.id, n.id);
    return { ...n, link: buildVlessLink(n, userUuid.uuid) };
  });

  res.render('panel', {
    user, userNodes, traffic, globalTraffic, formatBytes,
    subUrl: `${req.protocol}://${req.get('host')}/sub/${user.sub_token}`,
    announcement: db.getSetting('announcement') || '',
    hasAi: db.getEnabledAiProviders().length > 0
  });
});

// 获取可用 AI 模型列表
router.get('/ai/models', requireAuth, (req, res) => {
  const providers = db.getEnabledAiProviders();
  res.json(providers.map(p => ({
    id: p.id,
    name: p.model_name || p.name,
    type: p.type
  })));
});

// 用户 AI 流式对话
router.get('/ai/chat/stream', requireAuth, aiLimiter, async (req, res) => {
  const message = req.query.message;
  const providerId = req.query.provider;
  const sessionId = req.query.session;
  if (!message?.trim()) return res.status(400).end();

  const history = db.getAiChatHistory(req.user.id, 10, sessionId);
  db.addAiChat(req.user.id, 'user', message, providerId ? parseInt(providerId) : null, sessionId);
  const provider = providerId ? db.getAiProviderById(parseInt(providerId)) : null;
  db.addAuditLog(req.user.id, 'ai_chat', `AI 对话 [${provider?.name || '默认'}]`, req.ip);

  // 如果是新会话的第一条消息，用消息前20字做标题
  if (sessionId && history.length === 0) {
    db.updateAiSessionTitle(sessionId, message.slice(0, 20) + (message.length > 20 ? '...' : ''));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let fullResponse = '';
  let closed = false;
  req.on('close', () => { closed = true; });

  await aiService.chatStream(
    message,
    history,
    (chunk) => {
      if (closed) return;
      fullResponse += chunk;
      try { res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`); } catch {}
    },
    () => {
      db.addAiChat(req.user.id, 'assistant', fullResponse, providerId ? parseInt(providerId) : null, sessionId);
      if (!closed) { try { res.write(`data: [DONE]\n\n`); res.end(); } catch {} }
    },
    (error) => {
      if (!closed) { try { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.write(`data: [DONE]\n\n`); res.end(); } catch {} }
    },
    providerId ? parseInt(providerId) : undefined
  );
});

// 会话列表
router.get('/ai/sessions', requireAuth, (req, res) => {
  res.json(db.getAiSessions(req.user.id));
});

// 新建会话
router.post('/ai/sessions', requireAuth, (req, res) => {
  const id = require('crypto').randomUUID();
  const session = db.createAiSession(req.user.id, id, '新对话');
  res.json(session);
});

// 删除会话
router.delete('/ai/sessions/:id', requireAuth, (req, res) => {
  db.deleteAiSession(req.params.id, req.user.id);
  res.json({ ok: true });
});

// 获取用户对话历史
router.get('/ai/chat/history', requireAuth, (req, res) => {
  const sessionId = req.query.session;
  const history = db.getAiChatHistory(req.user.id, 50, sessionId);
  res.json(history);
});

// 清空用户对话历史
router.post('/ai/chat/clear', requireAuth, (req, res) => {
  db.clearAiChatHistory(req.user.id);
  res.json({ ok: true });
});

// 当前登录用户订阅二维码（便于手机扫码）
router.get('/sub-qr', requireAuth, async (req, res) => {
  try {
    const subUrl = `${req.protocol}://${req.get('host')}/sub/${req.user.sub_token}`;
    const png = await QRCode.toBuffer(subUrl, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store'
    });
    res.send(png);
  } catch (e) {
    console.error('[二维码] 生成失败:', e.message);
    res.status(500).send('二维码生成失败');
  }
});

// 订阅接口（每个用户返回自己的 UUID）
router.get('/sub/:token', subLimiter, (req, res) => {
  const user = db.getUserBySubToken(req.params.token);
  if (!user) return res.status(403).send('无效的订阅链接');

  // 记录拉取 IP（优先真实来源 IP）
  const clientIP = getRealClientIp(req);
  db.logSubAccess(user.id, clientIP, req.headers['user-agent']);

  // 滥用检测：24h 内 ≥20 个不同 IP 触发通知（同一用户1小时内只通知一次）
  const ips = db.getSubAccessIPs(user.id, 24);
  if (ips.length >= 20) {
    if (!global._abuseCache) global._abuseCache = new Map();
    const now = Date.now();
    const last = global._abuseCache.get(user.id) || 0;
    if (now - last > 3600000) {
      global._abuseCache.set(user.id, now);
      // 清理过期条目
      for (const [k, v] of global._abuseCache) { if (now - v > 3600000) global._abuseCache.delete(k); }
      const { notify } = require('../services/notify');
      notify.abuse(user.username, ips.length);
    }
  }

  const isVip = db.isInWhitelist(user.nodeloc_id);
  const nodes = db.getAllNodes(true).filter(n => isVip || user.trust_level >= (n.min_level || 0));
  const ua = req.headers['user-agent'] || '';
  const forceType = req.query.type;
  const clientType = forceType || detectClient(ua);
  db.ensureUserHasAllNodeUuids(user.id);

  // 获取用户在每个节点的 UUID
  const userNodes = nodes.map(n => {
    const userUuid = db.getUserNodeUuid(user.id, n.id);
    return { ...n, uuid: userUuid.uuid };
  });

  // 获取用户流量用于 Subscription-Userinfo
  const traffic = db.getUserTraffic(user.id);

  db.addAuditLog(user.id, 'sub_fetch', `订阅拉取 [${clientType}] IP: ${clientIP}`, clientIP);

  const subInfo = `upload=${traffic.total_up}; download=${traffic.total_down}; total=107374182400; expire=0`;

  if (clientType === 'clash') {
    res.set({
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clash.yaml"',
      'Profile-Update-Interval': '6',
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    });
    return res.send(generateClashSubForUser(userNodes));
  }

  if (clientType === 'singbox') {
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="singbox.json"',
      'Cache-Control': 'no-cache'
    });
    return res.send(generateSingboxSubForUser(userNodes));
  }

  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'attachment; filename="nodes.txt"',
    'Subscription-Userinfo': subInfo,
    'Cache-Control': 'no-cache'
  });
  res.send(generateV2raySubForUser(userNodes));
});

module.exports = router;
