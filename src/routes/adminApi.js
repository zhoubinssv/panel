const express = require('express');
const db = require('../services/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// 校验工具（共享给子路由）
function parseIntId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;
function isValidHost(host) {
  return typeof host === 'string' && HOST_RE.test(host.trim());
}

// 挂载子路由
router.use('/', require('./admin/adminWhitelist'));
router.use('/', require('./admin/adminNodes'));
router.use('/', require('./admin/adminUsers'));
router.use('/', require('./admin/adminAws'));
router.use('/', require('./admin/adminAgents'));
router.use('/', require('./admin/adminSettings'));
router.use('/', require('./admin/adminTraffic'));
router.use('/', require('./admin/adminBackup'));
router.use('/', require('./admin/adminDonations'));

module.exports = router;
module.exports.parseIntId = parseIntId;
module.exports.isValidHost = isValidHost;
