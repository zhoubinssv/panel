const express = require('express');
const db = require('../services/database');
const { buildVlessLink, buildSsLink, generateV2raySubForUser, generateClashSubForUser, generateSingboxSubForUser, generateV2raySsSub, generateClashSsSub, generateSingboxSsSub, detectClient } = require('../utils/vless');
const { formatBytes } = require('../utils/vless');
const { requireAuth } = require('../middleware/auth');
const { subLimiter } = require('../middleware/rateLimit');
const QRCode = require('qrcode');
const { notify } = require('../services/notify');
const { getOnlineCache } = require('../services/health');
const { escapeHtml } = require('../utils/escapeHtml');

// 模块级缓存（替代 global 变量）
const _abuseCache = new Map();
const _globalTrafficCache = { data: null, ts: 0 };
const _nodeAiTagsCache = { data: {}, ts: 0 };

const GLOBAL_TRAFFIC_TTL = 30000; // 30s
const NODE_AI_TAGS_TTL = 5 * 60 * 1000; // 5m

const router = express.Router();

// ========== 订阅接口内存缓存 ==========
const _subCache = new Map(); // token -> { data, headers, ts }
const SUB_CACHE_TTL = 60000; // 60秒缓存

function invalidateSubCache(token) {
  if (token) _subCache.delete(token);
  else _subCache.clear();
}

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
function getNowShanghaiParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return {
    year: parseInt(p.year), month: parseInt(p.month), day: parseInt(p.day),
    hour: parseInt(p.hour), minute: parseInt(p.minute), second: parseInt(p.second)
  };
}

function shanghaiToUtcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  // 上海固定 UTC+8
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function nextUuidResetAtMs(now = new Date()) {
  const n = getNowShanghaiParts(now);
  const today3 = shanghaiToUtcMs(n.year, n.month, n.day, 3, 0, 0);
  if (now.getTime() < today3) return today3;
  const t = new Date(shanghaiToUtcMs(n.year, n.month, n.day, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + 1);
  const y = getNowShanghaiParts(t);
  return shanghaiToUtcMs(y.year, y.month, y.day, 3, 0, 0);
}

function nextTokenResetAtMs(user, now = new Date()) {
  // 根据用户等级计算下次订阅重置时间
  const level = user.trust_level || 0;
  const isDonor = !!(user.is_donor || user.isDonor || user.donor);

  // Lv4 不重置
  if (level >= 4) return -1;

  // Lv3 或捐赠者：月初重置
  if (level >= 3 || isDonor) {
    const n = getNowShanghaiParts(now);
    // 下个月1号 03:00
    let nextMonth = n.month + 1;
    let nextYear = n.year;
    if (nextMonth > 12) { nextMonth = 1; nextYear++; }
    return shanghaiToUtcMs(nextYear, nextMonth, 1, 3, 0, 0);
  }

  // Lv0-1: 7天, Lv2: 15天
  const interval = level >= 2 ? 15 : 7;
  const last = user.last_token_reset || '2000-01-01';
  const [y,m,d] = String(last).split('-').map(v => parseInt(v));
  if (!y || !m || !d) return nextUuidResetAtMs(now);
  const last3 = shanghaiToUtcMs(y, m, d, 3, 0, 0);
  let next = new Date(last3);
  next.setUTCDate(next.getUTCDate() + interval);
  // 如果算出来的时间已过期，往前推到下一个周期
  while (next.getTime() < now.getTime()) {
    next.setUTCDate(next.getUTCDate() + interval);
  }
  return next.getTime();
}

function getGlobalTrafficCached() {
  const now = Date.now();
  if (_globalTrafficCache.data && now - _globalTrafficCache.ts < GLOBAL_TRAFFIC_TTL) {
    return _globalTrafficCache.data;
  }
  const data = db.getGlobalTraffic();
  _globalTrafficCache.data = data;
  _globalTrafficCache.ts = now;
  return data;
}

function getNodeAiTagsCached(nodes) {
  const now = Date.now();
  if (_nodeAiTagsCache.data && now - _nodeAiTagsCache.ts < NODE_AI_TAGS_TTL) {
    return _nodeAiTagsCache.data;
  }

  const nodeAiTags = {};
  try {
    const d = db.getDb();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const swapNodes = d.prepare(`
      SELECT DISTINCT detail FROM audit_log
      WHERE action IN ('auto_swap_ip','swap_ip','ip_rotated') AND created_at > ?
    `).all(sevenDaysAgo);

    nodes.forEach(n => {
      const tags = [];
      const swapMatch = swapNodes.some(r => (r.detail || '').includes(n.name) || (r.detail || '').includes(n.host));
      if (swapMatch) tags.push('ai_swap');
      if (tags.length) nodeAiTags[n.id] = tags;
    });
  } catch (_) {}

  _nodeAiTagsCache.data = nodeAiTags;
  _nodeAiTagsCache.ts = now;
  return nodeAiTags;
}

router.get('/', requireAuth, (req, res) => {
  const isVip = db.isInWhitelist(req.user.nodeloc_id);
  const user = req.user;

  // 0级用户显示升级提示
  if (!isVip && user.trust_level < 1) {
    return res.render('upgrade', { user });
  }

  const nodes = db.getAllNodes(true).filter(n => isVip || req.user.trust_level >= (n.min_level || 0));

  const traffic = db.getUserTraffic(user.id);
  const globalTraffic = getGlobalTrafficCached();

  const userNodes = nodes.map(n => {
    const userUuid = db.getUserNodeUuid(user.id, n.id);
    return { ...n, link: n.protocol === 'ss' ? buildSsLink(n, userUuid.uuid) : buildVlessLink(n, userUuid.uuid) };
  });

  const nodeAiTags = getNodeAiTagsCached(nodes);

  res.render('panel', {
    user, userNodes, traffic, globalTraffic, formatBytes,
    trafficLimit: user.traffic_limit || 0,
    nodeAiTags,
    subUrl: `${req.protocol}://${req.get('host')}/sub/${user.sub_token}`,
    subUrl6: `${req.protocol}://${req.get('host')}/sub6/${user.sub_token}`,
    nextUuidResetAt: nextUuidResetAtMs(),
    nextSubResetAt: nextTokenResetAtMs(user),
    announcement: db.getSetting('announcement') || '',
    expiresAt: user.expires_at || null,
  });
});

// ========== 蜜桃酱 AI 运维状态 API ==========
router.get('/api/peach-status', requireAuth, (req, res) => {
  try {
    const d = db.getDb();
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

    const todayStats = d.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE action LIKE '%patrol%' OR action = 'health_check') as patrols,
        COUNT(*) FILTER (WHERE action IN ('auto_swap_ip','swap_ip','ip_rotated')) as swaps,
        COUNT(*) FILTER (WHERE action IN ('auto_repair','node_recovered')) as fixes
      FROM audit_log WHERE date(created_at) = ?
    `).get(today) || { patrols: 0, swaps: 0, fixes: 0 };

    const totalStats = d.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE action LIKE '%patrol%' OR action = 'health_check') as patrols,
        COUNT(*) FILTER (WHERE action IN ('auto_swap_ip','swap_ip','ip_rotated')) as swaps,
        COUNT(*) FILTER (WHERE action IN ('auto_repair','node_recovered')) as fixes
      FROM audit_log
    `).get() || { patrols: 0, swaps: 0, fixes: 0 };

    const lastPatrol = db.getSetting('ops_last_patrol') || '';
    const nodes = db.getAllNodes(true);
    const onlineCount = nodes.filter(n => n.agent_last_report && (Date.now() - new Date(n.agent_last_report).getTime()) < 120000).length;
    const totalActive = nodes.length;

    // 最早审计记录算运行天数
    const firstLog = d.prepare("SELECT created_at FROM audit_log ORDER BY created_at ASC LIMIT 1").get();
    const uptimeDays = firstLog ? Math.max(1, Math.ceil((Date.now() - new Date(firstLog.created_at).getTime()) / 86400000)) : 1;

    const recentEvents = d.prepare(`
      SELECT action, detail, created_at FROM audit_log
      WHERE action IN ('health_check','auto_swap_ip','swap_ip','ip_rotated','node_recovered','auto_repair','deploy','node_blocked','node_xray_down')
      ORDER BY created_at DESC LIMIT 5
    `).all();

    res.json({
      online: true,
      lastPatrol,
      todayPatrols: todayStats.patrols,
      todaySwaps: todayStats.swaps,
      todayFixes: todayStats.fixes,
      totalPatrols: totalStats.patrols,
      totalSwaps: totalStats.swaps,
      totalFixes: totalStats.fixes,
      uptimeDays,
      nodeAvailability: totalActive > 0 ? Math.round(onlineCount / totalActive * 100) : 100,
      nodesOnline: onlineCount,
      nodesTotal: totalActive,
      recentEvents: recentEvents.map(e => ({
        action: escapeHtml(e.action),
        detail: escapeHtml((e.detail || '').slice(0, 80)),
        time: (e.created_at || '').replace('T', ' ').slice(0, 16)
      }))
    });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

// 当前登录用户订阅二维码（便于手机扫码）
async function sendSubQr(req, res, type = 'v4') {
  try {
    const isV6 = type === 'v6';
    const subPath = isV6 ? 'sub6' : 'sub';
    const subUrl = `${req.protocol}://${req.get('host')}/${subPath}/${req.user.sub_token}`;
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
    console.error(`[二维码] ${type === 'v6' ? 'IPv6' : '默认'}生成失败:`, e.message);
    res.status(500).send('二维码生成失败');
  }
}

router.get('/sub-qr', requireAuth, async (req, res) => sendSubQr(req, res, 'v4'));
router.get('/sub-qr/:type', requireAuth, async (req, res) => {
  const type = (req.params.type || '').toLowerCase();
  return sendSubQr(req, res, type === '6' || type === 'v6' ? 'v6' : 'v4');
});

// 兼容旧路径
router.get('/sub6-qr', requireAuth, async (req, res) => sendSubQr(req, res, 'v6'));

function maybeNotifySubAbuse(userId, username) {
  const ips = db.getSubAccessIPs(userId, 24);
  if (ips.length < 20) return;

  const now = Date.now();
  const last = _abuseCache.get(userId) || 0;
  if (now - last <= 3600000) return;

  _abuseCache.set(userId, now);
  for (const [k, v] of _abuseCache) {
    if (now - v > 3600000) _abuseCache.delete(k);
  }
  notify.abuse(username, ips.length);
}

function respondSubscriptionByClient({ res, clientType, cacheKey, userId, panelName, subInfo, nodes, traffic, totalBytes, generators }) {
  const encodedPanelName = encodeURIComponent(panelName);

  if (clientType === 'clash') {
    const headers = {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedPanelName}`,
      'Profile-Update-Interval': '6',
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generators.clash(nodes);
    _subCache.set(cacheKey, { headers, body, ts: Date.now(), userId });
    res.set(headers);
    return res.send(body);
  }

  if (clientType === 'singbox') {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedPanelName}`,
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generators.singbox(nodes);
    _subCache.set(cacheKey, { headers, body, ts: Date.now(), userId });
    res.set(headers);
    return res.send(body);
  }

  {
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedPanelName}`,
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generators.v2ray(nodes, { upload: traffic.total_up, download: traffic.total_down, total: totalBytes });
    _subCache.set(cacheKey, { headers, body, ts: Date.now(), userId });
    res.set(headers);
    return res.send(body);
  }
}

function handleSubscription(req, res, options) {
  const token = req.params.token;
  const ua = req.headers['user-agent'] || '';
  if (!ua.trim()) {
    return res.status(403).type('text').send('User-Agent is required');
  }

  const forceType = req.query.type;
  const clientType = forceType || detectClient(ua);
  const cacheKey = `${options.cachePrefix || ''}${token}:${clientType}`;
  const clientIP = getRealClientIp(req);

  const cached = _subCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUB_CACHE_TTL) {
    if (cached.userId) db.logSubAccess(cached.userId, clientIP, ua);
    res.set(cached.headers);
    return res.send(cached.body);
  }

  const user = db.getUserBySubToken(token);
  if (!user) return res.status(403).send('无效的订阅链接');
  if (user.trust_level < 1 && !db.isInWhitelist(user.nodeloc_id)) {
    return res.status(403).send('账号等级不足，请在 NodeLoc 论坛升级到1级后使用');
  }

  db.logSubAccess(user.id, clientIP, ua);
  if (options.enableAbuseDetect) {
    maybeNotifySubAbuse(user.id, user.username);
  }

  const nodes = options.pickNodes(user);
  const traffic = db.getUserTraffic(user.id);
  const trafficLimit = user.traffic_limit || 0;
  const totalBytes = trafficLimit > 0 ? trafficLimit : 1125899906842624;
  const exceeded = trafficLimit > 0 && (traffic.total_up + traffic.total_down) >= trafficLimit;
  const finalNodes = exceeded ? [] : nodes;
  const subInfo = `upload=${traffic.total_up}; download=${traffic.total_down}; total=${totalBytes}; expire=0`;

  return respondSubscriptionByClient({
    res,
    clientType,
    cacheKey,
    userId: user.id,
    panelName: options.panelName,
    subInfo,
    nodes: finalNodes,
    traffic,
    totalBytes,
    generators: options.generators,
  });
}

// 订阅接口（每个用户返回自己的 UUID）
router.get('/sub/:token', subLimiter, (req, res) => handleSubscription(req, res, {
  panelName: '小姨子的诱惑',
  enableAbuseDetect: true,
  pickNodes: (user) => db.getUserNodesWithUuids(user.id, true).filter(n => n.protocol !== 'ss'),
  generators: {
    clash: (nodes) => generateClashSubForUser(nodes),
    singbox: (nodes) => generateSingboxSubForUser(nodes),
    v2ray: (nodes, usage) => generateV2raySubForUser(nodes, usage)
  }
}));

// ========== IPv6 Shadowsocks 订阅接口 ==========
router.get('/sub6/:token', subLimiter, (req, res) => handleSubscription(req, res, {
  panelName: '小姨子的诱惑-IPv6',
  cachePrefix: 'v6:',
  enableAbuseDetect: false,
  pickNodes: (user) => db.getUserNodesWithUuids(user.id, true)
    .filter(n => n.ip_version === 6 && n.protocol === 'ss')
    .map(n => ({ ...n, userPassword: n.uuid })),
  generators: {
    clash: (nodes) => generateClashSsSub(nodes),
    singbox: (nodes) => generateSingboxSsSub(nodes),
    v2ray: (nodes, usage) => generateV2raySsSub(nodes, usage)
  }
}));

// 在线用户数（从巡检缓存读取）
router.get('/online-count', requireAuth, (req, res) => {
  const cache = getOnlineCache();
  const summary = cache.summary || { online: 0, nodes: 0 };
  res.json(summary);
});

// 实时统计 API（前端轮询用）
router.get('/api/stats', requireAuth, (req, res) => {
  const cache = getOnlineCache();
  const summary = cache.summary || { online: 0, nodes: 0 };
  const traffic = db.getUserTraffic(req.user.id);
  const user = db.getUserById(req.user.id);
  const trafficLimit = user ? (user.traffic_limit || 0) : 0;
  const totalUsed = (traffic.total_up || 0) + (traffic.total_down || 0);
  const remaining = trafficLimit > 0 ? Math.max(0, trafficLimit - totalUsed) : -1; // -1 = unlimited
  const globalTraffic = getGlobalTrafficCached();
  res.json({
    online: summary.online || 0,
    totalUsed,
    remaining,
    trafficLimit,
    globalUp: globalTraffic.total_up || 0,
    globalDown: globalTraffic.total_down || 0,
  });
});

// Sprint 6: 用户流量使用明细 API
router.get('/api/traffic-detail', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const detail = db.getUserTrafficDaily(req.user.id, days);
  const trend = db.getUserTrafficDailyAgg(req.user.id, days);
  res.json({ ok: true, detail, trend });
});

// Sprint 6: 节点延迟测试 API（TCP ping）


module.exports = router;
