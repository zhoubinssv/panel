const express = require('express');
const db = require('../services/database');
const { buildVlessLink, generateV2raySubForUser, generateClashSubForUser, generateSingboxSubForUser, detectClient } = require('../utils/vless');
const { formatBytes } = require('../services/traffic');
const { requireAuth } = require('../middleware/auth');
const { subLimiter } = require('../middleware/rateLimit');
const QRCode = require('qrcode');
const { notify } = require('../services/notify');
const { getOnlineCache } = require('../services/health');

// 模块级缓存（替代 global 变量）
const _abuseCache = new Map();



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

function nextTokenResetAtMs(now = new Date()) {
  const last = db.getSetting('last_token_rotate') || '2000-01-01';
  const [y,m,d] = String(last).split('-').map(v => parseInt(v));
  if (!y || !m || !d) return nextUuidResetAtMs(now);
  const last3 = shanghaiToUtcMs(y, m, d, 3, 0, 0);
  const next = new Date(last3);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.getTime();
}

router.get('/', requireAuth, (req, res) => {
  const isVip = db.isInWhitelist(req.user.nodeloc_id);
  const nodes = db.getAllNodes(true).filter(n => isVip || req.user.trust_level >= (n.min_level || 0));
  const user = req.user;

  const traffic = db.getUserTraffic(user.id);
  const globalTraffic = db.getGlobalTraffic();

  const userNodes = nodes.map(n => {
    const userUuid = db.getUserNodeUuid(user.id, n.id);
    return { ...n, link: buildVlessLink(n, userUuid.uuid) };
  });

  res.render('panel', {
    user, userNodes, traffic, globalTraffic, formatBytes,
    trafficLimit: user.traffic_limit || 0,
    subUrl: `${req.protocol}://${req.get('host')}/sub/${user.sub_token}`,
    nextUuidResetAt: nextUuidResetAtMs(),
    nextSubResetAt: nextTokenResetAtMs(),
    announcement: db.getSetting('announcement') || '',
  });
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
  const token = req.params.token;
  const ua = req.headers['user-agent'] || '';
  const forceType = req.query.type;
  const clientType = forceType || detectClient(ua);
  const cacheKey = `${token}:${clientType}`;

  // 记录拉取 IP（始终执行，不受缓存影响）
  const clientIP = getRealClientIp(req);

  // 检查缓存
  const cached = _subCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUB_CACHE_TTL) {
    // 异步记录访问日志
    const user = db.getUserBySubToken(token);
    if (user) {
      db.logSubAccess(user.id, clientIP, ua);
    }
    res.set(cached.headers);
    return res.send(cached.body);
  }

  const user = db.getUserBySubToken(token);
  if (!user) return res.status(403).send('无效的订阅链接');

  db.logSubAccess(user.id, clientIP, ua);

  // 滥用检测：24h 内 ≥20 个不同 IP 触发通知（同一用户1小时内只通知一次）
  const ips = db.getSubAccessIPs(user.id, 24);
  if (ips.length >= 20) {
    
    const now = Date.now();
    const last = _abuseCache.get(user.id) || 0;
    if (now - last > 3600000) {
      _abuseCache.set(user.id, now);
      // 清理过期条目
      for (const [k, v] of _abuseCache) { if (now - v > 3600000) _abuseCache.delete(k); }
      
      notify.abuse(user.username, ips.length);
    }
  }

  const isVip = db.isInWhitelist(user.nodeloc_id);
  const nodes = db.getAllNodes(true).filter(n => isVip || user.trust_level >= (n.min_level || 0));

  // 获取用户在每个节点的 UUID
  const userNodes = nodes.map(n => {
    const userUuid = db.getUserNodeUuid(user.id, n.id);
    return { ...n, uuid: userUuid.uuid };
  });

  // 获取用户流量用于 Subscription-Userinfo
  const traffic = db.getUserTraffic(user.id);
  const trafficLimit = user.traffic_limit || 0;
  const totalBytes = trafficLimit > 0 ? trafficLimit : 1125899906842624; // 默认 1PB
  const exceeded = trafficLimit > 0 && (traffic.total_up + traffic.total_down) >= trafficLimit;

  db.addAuditLog(user.id, 'sub_fetch', `订阅拉取 [${clientType}] IP: ${clientIP}`, clientIP);

  // 流量超额则返回空节点列表
  const finalNodes = exceeded ? [] : userNodes;
  const subInfo = `upload=${traffic.total_up}; download=${traffic.total_down}; total=${totalBytes}; expire=0`;

  const panelName = encodeURIComponent('小姨子的诱惑');

  if (clientType === 'clash') {
    const headers = {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${panelName}`,
      'Profile-Update-Interval': '6',
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generateClashSubForUser(finalNodes);
    _subCache.set(cacheKey, { headers, body, ts: Date.now() });
    res.set(headers);
    return res.send(body);
  }

  if (clientType === 'singbox') {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${panelName}`,
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generateSingboxSubForUser(finalNodes);
    _subCache.set(cacheKey, { headers, body, ts: Date.now() });
    res.set(headers);
    return res.send(body);
  }

  {
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${panelName}`,
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache'
    };
    const body = generateV2raySubForUser(finalNodes, { upload: traffic.total_up, download: traffic.total_down, total: totalBytes });
    _subCache.set(cacheKey, { headers, body, ts: Date.now() });
    res.set(headers);
    res.send(body);
  }
});

// 在线用户数（从巡检缓存读取，每 5 分钟自动刷新）
router.get('/online-count', requireAuth, (req, res) => {
  
  const cache = getOnlineCache();
  const summary = cache.summary || { online: '-', nodes: 0 };
  // 前台显示 2 倍在线人数
  const display = typeof summary.online === 'number'
    ? { ...summary, online: summary.online * 2 }
    : summary;
  res.json(display);
});

module.exports = router;
