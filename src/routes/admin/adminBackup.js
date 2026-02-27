const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../services/database');
const { performBackup, BACKUP_DIR } = require('../../services/backup');

const router = express.Router();

// 列出备份文件
router.get('/backups', (req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('panel-') && f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  res.json({ ok: true, backups: files });
});

// 手动触发备份
router.post('/backups/create', (req, res) => {
  try {
    performBackup(db.getDb());
    db.addAuditLog(req.user.id, 'backup_create', '手动创建备份', req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 下载备份
router.get('/backups/download/:name', (req, res) => {
  const name = req.params.name;
  if (!/^panel-[\w-]+\.db$/.test(name)) return res.status(400).json({ error: '无效文件名' });
  const filePath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  db.addAuditLog(req.user.id, 'backup_download', `下载备份: ${name}`, req.ip);
  res.download(filePath, name);
});

// 从备份恢复
router.post('/backups/restore', (req, res) => {
  const { name } = req.body;
  if (!/^panel-[\w-]+\.db$/.test(name)) return res.status(400).json({ error: '无效文件名' });
  const backupPath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: '备份文件不存在' });

  const dbPath = path.join(__dirname, '..', '..', '..', 'data', 'panel.db');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  try {
    // 先备份当前数据库
    performBackup(db.getDb());

    // 关闭连接后再覆盖，避免 WAL/映射状态不一致
    db.closeDb();
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    // 复制备份文件覆盖当前数据库
    fs.copyFileSync(backupPath, dbPath);

    // 立即重建连接，确保后续请求使用新数据库文件
    db.reopenDb();
    db.addAuditLog(null, 'backup_restore', `从备份恢复: ${name}`, req.ip);
    res.json({ ok: true, message: '恢复成功' });
  } catch (err) {
    // 尽量恢复服务可用性
    try { db.reopenDb(); } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
