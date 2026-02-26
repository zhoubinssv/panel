const { encrypt, decrypt } = require('../../utils/crypto');

let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

function decryptAwsAccount(a) {
  if (!a) return a;
  a.access_key = decrypt(a.access_key);
  a.secret_key = decrypt(a.secret_key);
  a.socks5_pass = decrypt(a.socks5_pass);
  return a;
}

function getAwsAccounts(enabledOnly = false) {
  const rows = enabledOnly
    ? _getDb().prepare('SELECT * FROM aws_accounts WHERE enabled = 1 ORDER BY id DESC').all()
    : _getDb().prepare('SELECT * FROM aws_accounts ORDER BY id DESC').all();
  return rows.map(decryptAwsAccount);
}

function getAwsAccountById(id) {
  return decryptAwsAccount(_getDb().prepare('SELECT * FROM aws_accounts WHERE id = ?').get(id));
}

function addAwsAccount(account) {
  return _getDb().prepare(`
    INSERT INTO aws_accounts (name, access_key, secret_key, default_region, socks5_host, socks5_port, socks5_user, socks5_pass, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
  `).run(
    account.name,
    encrypt(account.access_key),
    encrypt(account.secret_key),
    account.default_region || 'ap-northeast-1',
    account.socks5_host || null,
    account.socks5_port || 1080,
    account.socks5_user || null,
    encrypt(account.socks5_pass) || null,
    account.enabled === false ? 0 : 1
  );
}

function updateAwsAccount(id, fields) {
  const safe = { ...fields };
  if (safe.access_key) safe.access_key = encrypt(safe.access_key);
  if (safe.secret_key) safe.secret_key = encrypt(safe.secret_key);
  if (safe.socks5_pass) safe.socks5_pass = encrypt(safe.socks5_pass);
  const allowed = ['name','access_key','secret_key','default_region','socks5_host','socks5_port','socks5_user','socks5_pass','enabled'];
  const obj = Object.fromEntries(Object.entries(safe).filter(([k]) => allowed.includes(k)));
  obj.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  _getDb().prepare(`UPDATE aws_accounts SET ${sets} WHERE id = ?`).run(...keys.map(k => obj[k]), id);
}

function deleteAwsAccount(id) {
  _getDb().prepare('DELETE FROM aws_accounts WHERE id = ?').run(id);
}

module.exports = {
  init,
  getAwsAccounts, getAwsAccountById, addAwsAccount, updateAwsAccount, deleteAwsAccount
};
