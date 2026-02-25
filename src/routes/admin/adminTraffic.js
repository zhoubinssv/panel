const express = require('express');
const db = require('../../services/database');

const router = express.Router();

router.get('/traffic', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const range = req.query.range || req.query.date || 'today';
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getUsersTrafficByRange(range, limit, offset);
  res.json({ ...data, page });
});

router.get('/traffic/nodes', (req, res) => {
  const range = req.query.range || 'today';
  res.json({ rows: db.getNodesTrafficByRange(range) });
});

module.exports = router;
