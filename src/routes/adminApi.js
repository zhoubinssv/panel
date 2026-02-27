const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { parseIntId } = require('../utils/parseIntId');
const { isValidHost } = require('../utils/hostValidator');

const router = express.Router();
router.use(requireAuth, requireAdmin);

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
