const { NodeSSH } = require('node-ssh');
const { v4: uuidv4 } = require('uuid');
const { randomPort } = require('../utils/vless');
const { BEAUTIFUL_NAMES } = require('../utils/names');

// 地区 emoji 映射
const REGION_EMOJI = {
  'singapore': '🇸🇬', 'tokyo': '🇯🇵', 'japan': '🇯🇵', 'osaka': '🇯🇵',
  'seoul': '🇰🇷', 'korea': '🇰🇷', 'hong kong': '🇭🇰', 'hongkong': '🇭🇰',
  'taiwan': '🇹🇼', 'mumbai': '🇮🇳', 'india': '🇮🇳',
  'sydney': '🇦🇺', 'australia': '🇦🇺',
  'london': '🇬🇧', 'uk': '🇬🇧', 'united kingdom': '🇬🇧',
  'frankfurt': '🇩🇪', 'germany': '🇩🇪',
  'paris': '🇫🇷', 'france': '🇫🇷',
  'amsterdam': '🇳🇱', 'netherlands': '🇳🇱',
  'virginia': '🇺🇸', 'ohio': '🇺🇸', 'oregon': '🇺🇸', 'california': '🇺🇸',
  'us': '🇺🇸', 'united states': '🇺🇸', 'america': '🇺🇸',
  'canada': '🇨🇦', 'brazil': '🇧🇷', 'são paulo': '🇧🇷',
};

const CITY_CN = {
  'singapore': '新加坡', 'tokyo': '东京', 'osaka': '大阪',
  'seoul': '首尔', 'hong kong': '香港', 'hongkong': '香港',
  'taipei': '台北', 'mumbai': '孟买', 'sydney': '悉尼',
  'london': '伦敦', 'frankfurt': '法兰克福', 'paris': '巴黎',
  'amsterdam': '阿姆斯特丹', 'virginia': '弗吉尼亚', 'ohio': '俄亥俄',
  'oregon': '俄勒冈', 'california': '加利福尼亚', 'são paulo': '圣保罗',
  'toronto': '多伦多', 'jakarta': '雅加达', 'bangkok': '曼谷',
  'dubai': '迪拜', 'stockholm': '斯德哥尔摩', 'dublin': '都柏林',
  'milan': '米兰', 'zurich': '苏黎世', 'warsaw': '华沙',
  'cape town': '开普敦', 'bahrain': '巴林',
};

function getRegionEmoji(city, country) {
  const key = (city || country || '').toLowerCase();
  for (const [k, v] of Object.entries(REGION_EMOJI)) {
    if (key.includes(k)) return v;
  }
  return '🌐';
}

function getCityCN(city) {
  const key = (city || '').toLowerCase();
  for (const [k, v] of Object.entries(CITY_CN)) {
    if (key.includes(k)) return v;
  }
  return city || '未知';
}

async function detectRegion(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city&lang=en`);
    const data = await res.json();
    if (data.status === 'success') {
      return {
        city: data.city, region: data.regionName, country: data.country,
        cityCN: getCityCN(data.city),
        emoji: getRegionEmoji(data.city, data.country)
      };
    }
  } catch (e) {
    console.error(`[地区检测] ${ip} 失败:`, e.message);
  }
  return { city: 'Unknown', region: '', country: '', cityCN: '未知', emoji: '🌐' };
}

function generateNodeName(geo, existingNodes, isHomeNetwork = false) {
  const city = geo.cityCN;
  const prefix = isHomeNetwork ? '🏠' : geo.emoji;
  const usedNames = new Set(existingNodes.map(n => {
    const match = n.name.match(/-(.{4})$/);
    return match ? match[1] : '';
  }));
  const available = BEAUTIFUL_NAMES.filter(n => !usedNames.has(n));
  const name = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : BEAUTIFUL_NAMES[Math.floor(Math.random() * BEAUTIFUL_NAMES.length)];
  return `${prefix} ${city}-${name}`;
}

// ========== 生成 xray 多用户配置 ==========

// 构建 clients 数组 JSON（带 email 标签用于流量统计）
function buildClientsJson(userUuids) {
  const clients = userUuids.map(u => ({
    id: u.uuid,
    level: 0,
    email: `user-${u.user_id}@panel`
  }));
  return JSON.stringify(clients);
}

// 生成完整 xray 配置（多用户 + stats + API + Reality）
function buildXrayConfig(port, clients, outbounds, realityOpts) {
  const streamSettings = { network: 'tcp', security: 'reality' };
  if (realityOpts) {
    // Reality 模式下 clients 需要 flow
    clients = clients.map(c => ({ ...c, flow: 'xtls-rprx-vision' }));
    streamSettings.realitySettings = {
      show: false,
      dest: `${realityOpts.sni}:443`,
      xver: 0,
      serverNames: [realityOpts.sni],
      privateKey: realityOpts.privateKey,
      shortIds: [realityOpts.shortId]
    };
  }
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      {
        port,
        protocol: 'vless',
        tag: 'vless-in',
        settings: { clients, decryption: 'none' },
        streamSettings
      },
      {
        listen: '127.0.0.1', port: 10085,
        protocol: 'dokodemo-door', tag: 'api-in',
        settings: { address: '127.0.0.1' }
      }
    ],
    outbounds,
    routing: {
      rules: [
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api' },
        ...(outbounds[0]?.tag === 'socks5-out'
          ? [{ type: 'field', outboundTag: 'socks5-out', network: 'tcp,udp' }]
          : [])
      ]
    }
  };
}

// ========== SSH 推送配置 ==========

// 将配置推送到节点并重启 xray
async function pushConfigToNode(node, config) {
  const ssh = new NodeSSH();
  try {
    const connectOpts = {
      host: node.ssh_host || node.host,
      port: node.ssh_port || 22,
      username: node.ssh_user || 'root',
    };
    if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
    else if (node.ssh_password) connectOpts.password = node.ssh_password;

    await ssh.connect(connectOpts);

    const configJson = JSON.stringify(config, null, 2);
    const configPath = node.xray_config_path || '/usr/local/etc/xray/config.json';

    // 写入配置并重启
    await ssh.execCommand(`cat > ${configPath} << 'CONFIGEOF'\n${configJson}\nCONFIGEOF`);
    const result = await ssh.execCommand('systemctl restart xray && sleep 1 && systemctl is-active --quiet xray && echo OK || echo FAIL');

    return result.stdout.trim() === 'OK';
  } catch (err) {
    console.error(`[推送配置] ${node.name} 失败: ${err.message}`);
    return false;
  } finally {
    ssh.dispose();
  }
}

// 同步某个节点的配置（用于新用户注册、轮换等场景）
async function syncNodeConfig(node, db) {
  const userUuids = db.getNodeAllUserUuids(node.id);
  if (userUuids.length === 0) return false;

  const clients = userUuids.map(u => ({
    id: u.uuid, level: 0, email: `user-${u.user_id}@panel`
  }));

  let outbounds;
  if (node.socks5_host) {
    const socks5Server = { address: node.socks5_host, port: node.socks5_port || 1080 };
    if (node.socks5_user) socks5Server.users = [{ user: node.socks5_user, pass: node.socks5_pass || '' }];
    outbounds = [
      { protocol: 'socks', tag: 'socks5-out', settings: { servers: [socks5Server] } },
      { protocol: 'freedom', tag: 'direct' }
    ];
  } else {
    outbounds = [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' }
    ];
  }

  const realityOpts = node.reality_private_key ? { privateKey: node.reality_private_key, sni: node.sni || 'www.microsoft.com', shortId: node.reality_short_id } : null;
  const config = buildXrayConfig(node.port, clients, outbounds, realityOpts);
  return await pushConfigToNode(node, config);
}

// 同步所有活跃节点的配置
async function syncAllNodesConfig(db) {
  const nodes = db.getAllNodes(true);
  let success = 0, failed = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < nodes.length; i += CONCURRENCY) {
    const batch = nodes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(n => syncNodeConfig(n, db).catch(() => false)));
    for (const ok of results) { if (ok) success++; else failed++; }
  }
  console.log(`[配置同步] 完成 成功:${success} 失败:${failed}`);
  return { success, failed };
}

// ========== 部署函数 ==========

async function deployNode(sshInfo, db) {
  const uuid = uuidv4();
  const port = randomPort();

  const geo = await detectRegion(sshInfo.host);

  let displayGeo = geo;
  let isHomeNetwork = false;
  if (sshInfo.socks5_host) {
    isHomeNetwork = true;
    const socks5Geo = await detectRegion(sshInfo.socks5_host);
    displayGeo = socks5Geo;
  }

  const existingNodes = db.getAllNodes();
  const name = generateNodeName(displayGeo, existingNodes, isHomeNetwork);
  const region = `${displayGeo.emoji} ${displayGeo.cityCN}`;

  const nodeData = {
    name, host: sshInfo.host, port, uuid,
    ssh_host: sshInfo.host,
    ssh_port: sshInfo.ssh_port || 22,
    ssh_user: sshInfo.ssh_user || 'root',
    ssh_password: sshInfo.ssh_password,
    ssh_key_path: sshInfo.ssh_key_path,
    socks5_host: sshInfo.socks5_host || null,
    socks5_port: parseInt(sshInfo.socks5_port) || 1080,
    socks5_user: sshInfo.socks5_user || null,
    socks5_pass: sshInfo.socks5_pass || null,
    region,
    remark: '⏳ 部署中...',
    is_active: 0
  };
  const result = db.addNode(nodeData);
  const nodeId = result.lastInsertRowid;

  // 为所有现有用户在新节点生成 UUID
  db.ensureAllUsersHaveUuid(nodeId);

  const ssh = new NodeSSH();
  try {
    const connectOpts = {
      host: sshInfo.host,
      port: sshInfo.ssh_port || 22,
      username: sshInfo.ssh_user || 'root',
    };
    if (sshInfo.ssh_key_path) connectOpts.privateKeyPath = sshInfo.ssh_key_path;
    else if (sshInfo.ssh_password) connectOpts.password = sshInfo.ssh_password;

    console.log(`[部署] ${name} (${sshInfo.host}) 开始...`);
    await ssh.connect(connectOpts);

    // 先安装 xray
    const installScript = `
set -e
apt-get update -qq && apt-get install -y -qq curl unzip jq > /dev/null 2>&1
if ! command -v xray &> /dev/null; then
  bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi
echo "INSTALL_OK"
`.trim();

    const installResult = await ssh.execCommand(installScript, { execOptions: { timeout: 180000 } });
    if (!installResult.stdout.includes('INSTALL_OK')) {
      throw new Error('xray 安装失败: ' + (installResult.stderr || installResult.stdout).substring(0, 200));
    }

    // 生成 Reality 密钥对
    const keyResult = await ssh.execCommand('xray x25519');
    const output = keyResult.stdout + '\n' + keyResult.stderr;
    // 兼容新旧版本: 旧版 "Private key:" / "Public key:", 新版 "PrivateKey:" / "Password:"
    const privMatch = output.match(/Private\s*[Kk]ey:\s*(\S+)/);
    const pubMatch = output.match(/Public\s*[Kk]ey:\s*(\S+)/) || output.match(/Password:\s*(\S+)/);
    if (!privMatch || !pubMatch) throw new Error('Reality 密钥生成失败: ' + output.substring(0, 200));
    const realityPrivateKey = privMatch[1];
    const realityPublicKey = pubMatch[1];
    const realityShortId = require('crypto').randomBytes(4).toString('hex');
    const sni = 'www.microsoft.com';

    db.updateNode(nodeId, { reality_private_key: realityPrivateKey, reality_public_key: realityPublicKey, reality_short_id: realityShortId, sni });

    // 生成多用户配置
    const userUuids = db.getNodeAllUserUuids(nodeId);
    const clients = userUuids.length > 0
      ? userUuids.map(u => ({ id: u.uuid, level: 0, email: `user-${u.user_id}@panel` }))
      : [{ id: uuid, level: 0, email: 'default@panel' }];

    let outbounds;
    if (sshInfo.socks5_host) {
      let socks5Settings = { address: sshInfo.socks5_host, port: parseInt(sshInfo.socks5_port) || 1080 };
      if (sshInfo.socks5_user) {
        socks5Settings.users = [{ user: sshInfo.socks5_user, pass: sshInfo.socks5_pass || '' }];
      }
      outbounds = [
        { protocol: 'socks', tag: 'socks5-out', settings: { servers: [socks5Settings] } },
        { protocol: 'freedom', tag: 'direct' }
      ];
    } else {
      outbounds = [
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'blocked' }
      ];
    }

    const config = buildXrayConfig(port, clients, outbounds, { privateKey: realityPrivateKey, sni, shortId: realityShortId });
    const configJson = JSON.stringify(config, null, 2);
    const configPath = '/usr/local/etc/xray/config.json';

    await ssh.execCommand(`mkdir -p /usr/local/etc/xray && cat > ${configPath} << 'CONFIGEOF'\n${configJson}\nCONFIGEOF`);
    const startResult = await ssh.execCommand('systemctl enable xray && systemctl restart xray && sleep 2 && systemctl is-active --quiet xray && echo DEPLOY_OK || echo DEPLOY_FAIL');

    if (startResult.stdout.includes('DEPLOY_OK')) {
      db.updateNode(nodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy', `部署成功: ${name} (${sshInfo.host}:${port}) [${clients.length}用户]`, 'system');
      console.log(`[部署成功] ${name} (${sshInfo.host}:${port}) ${clients.length}个用户`);
    } else {
      const errMsg = (startResult.stderr || startResult.stdout).substring(0, 200);
      db.updateNode(nodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_fail', `部署失败: ${name} - ${errMsg}`, 'system');
      console.error(`[部署失败] ${name}: ${errMsg}`);
    }
  } catch (err) {
    db.updateNode(nodeId, { remark: `❌ ${err.message}` });
    db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_fail', `部署异常: ${name} - ${err.message}`, 'system');
    console.error(`[部署异常] ${name}: ${err.message}`);
  } finally {
    ssh.dispose();
  }
}

module.exports = { deployNode, detectRegion, generateNodeName, syncNodeConfig, syncAllNodesConfig, pushConfigToNode };
