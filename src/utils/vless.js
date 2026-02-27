// 生成 vless 链接
function buildVlessLink(node, uuid) {
  const params = new URLSearchParams({ type: node.network || 'tcp' });
  if (node.reality_public_key) {
    params.set('security', 'reality');
    params.set('sni', node.sni || 'www.microsoft.com');
    params.set('fp', 'chrome');
    params.set('pbk', node.reality_public_key);
    params.set('sid', node.reality_short_id || '');
    params.set('flow', 'xtls-rprx-vision');
  } else {
    params.set('security', node.security || 'none');
  }
  return `vless://${uuid || node.uuid}@${node.host}:${node.port}?${params}#${encodeURIComponent(node.name)}`;
}

// 生成信息假节点 vless 链接
function buildInfoLink(text) {
  return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:0?type=tcp&security=none#${encodeURIComponent(text)}`;
}

// 格式化字节数
function formatBytes(bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

// v2ray 订阅（base64 编码的链接列表）
function generateV2raySub(nodes, trafficInfo) {
  const infoLinks = [];
  if (trafficInfo) {
    infoLinks.push(buildInfoLink('🍑 小姨子的诱惑 | vip.vip.sd'));
    const used = trafficInfo.upload + trafficInfo.download;
    if (trafficInfo.total > 0) {
      const remain = Math.max(0, trafficInfo.total - used);
      infoLinks.push(buildInfoLink(`📊 剩余: ${formatBytes(remain)} | 已用: ${formatBytes(used)}`));
    } else {
      infoLinks.push(buildInfoLink(`📊 已用: ${formatBytes(used)} | 无限制`));
    }
  }
  // 显式传入 uuid，优先使用调用方注入的用户专属 UUID
  const links = [...infoLinks, ...nodes.map(n => buildVlessLink(n, n.uuid))].join('\n');
  return Buffer.from(links).toString('base64');
}

// Clash Meta (mihomo) 订阅
function generateClashSub(nodes) {
  const proxies = nodes.map(n => {
    const p = {
      name: n.name, type: 'vless', server: n.host, port: n.port,
      uuid: n.uuid, network: n.network || 'tcp', udp: true
    };
    if (n.reality_public_key) {
      p.tls = true;
      p.servername = n.sni || 'www.microsoft.com';
      p['reality-opts'] = {
        'public-key': n.reality_public_key,
        'short-id': n.reality_short_id || ''
      };
      p['client-fingerprint'] = 'chrome';
      p.flow = 'xtls-rprx-vision';
    }
    return p;
  });

  const proxyNames = nodes.map(n => n.name);
  const config = {
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
    proxies,
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', ...proxyNames, 'DIRECT'] },
      { name: '♻️ 自动选择', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 }
    ],
    rules: ['GEOIP,LAN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,🚀 节点选择']
  };
  return clashConfigToYaml(config);
}

// sing-box 订阅
function generateSingboxSub(nodes) {
  const outbounds = nodes.map(n => {
    const o = {
      tag: n.name, type: 'vless', server: n.host, server_port: n.port,
      uuid: n.uuid, network: n.network || 'tcp'
    };
    if (n.reality_public_key) {
      o.flow = 'xtls-rprx-vision';
      o.tls = {
        enabled: true, server_name: n.sni || 'www.microsoft.com',
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: { enabled: true, public_key: n.reality_public_key, short_id: n.reality_short_id || '' }
      };
    }
    return o;
  });

  const tags = nodes.map(n => n.name);
  return JSON.stringify({
    log: { level: 'info' },
    outbounds: [
      { tag: '🚀 节点选择', type: 'selector', outbounds: ['♻️ 自动选择', ...tags, 'direct'] },
      { tag: '♻️ 自动选择', type: 'urltest', outbounds: tags, url: 'http://www.gstatic.com/generate_204', interval: '3m' },
      ...outbounds,
      { tag: 'direct', type: 'direct' },
      { tag: 'block', type: 'block' },
      { tag: 'dns-out', type: 'dns' }
    ],
    route: { auto_detect_interface: true, rules: [{ geoip: ['private', 'cn'], outbound: 'direct' }, { protocol: 'dns', outbound: 'dns-out' }], final: '🚀 节点选择' }
  }, null, 2);
}

// 简易 YAML 生成器
function clashConfigToYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  let yaml = '';
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) { yaml += `${pad}${key}: []\n`; }
      else if (typeof value[0] === 'object') {
        yaml += `${pad}${key}:\n`;
        for (const item of value) {
          const entries = Object.entries(item);
          entries.forEach(([k, v], i) => {
            const prefix = i === 0 ? `${pad}  - ` : `${pad}    `;
            if (Array.isArray(v)) {
              yaml += `${prefix}${k}:\n`;
              for (const sv of v) yaml += `${pad}      - ${typeof sv === 'string' ? `"${sv}"` : sv}\n`;
            } else if (typeof v === 'object' && v !== null) {
              yaml += `${prefix}${k}:\n`;
              for (const [sk, sv] of Object.entries(v)) yaml += `${pad}      ${sk}: ${fmtYaml(sv)}\n`;
            } else {
              yaml += `${prefix}${k}: ${fmtYaml(v)}\n`;
            }
          });
        }
      } else {
        yaml += `${pad}${key}:\n`;
        for (const item of value) yaml += `${pad}  - ${typeof item === 'string' ? `"${item}"` : item}\n`;
      }
    } else if (typeof value === 'object' && value !== null) {
      yaml += `${pad}${key}:\n${clashConfigToYaml(value, indent + 2)}`;
    } else {
      yaml += `${pad}${key}: ${fmtYaml(value)}\n`;
    }
  }
  return yaml;
}

function fmtYaml(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

// ========== Shadowsocks 订阅生成 ==========

function buildSsLink(node, userPassword) {
  const method = node.ss_method || 'aes-256-gcm';
  const password = userPassword || node.ss_password || '';
  const userinfo = Buffer.from(`${method}:${password}`).toString('base64');
  // IPv6 地址用方括号包裹
  const host = node.host.includes(':') ? `[${node.host}]` : node.host;
  return `ss://${userinfo}@${host}:${node.port}#${encodeURIComponent(node.name)}`;
}

function buildSsInfoLink(text) {
  const userinfo = Buffer.from('aes-256-gcm:00000000').toString('base64');
  return `ss://${userinfo}@127.0.0.1:0#${encodeURIComponent(text)}`;
}

function generateV2raySsSub(nodes, trafficInfo) {
  const infoLinks = [];
  if (trafficInfo) {
    infoLinks.push(buildSsInfoLink('🍑 小姨子的诱惑 | vip.vip.sd [IPv6]'));
    const used = trafficInfo.upload + trafficInfo.download;
    if (trafficInfo.total > 0) {
      const remain = Math.max(0, trafficInfo.total - used);
      infoLinks.push(buildSsInfoLink(`📊 剩余: ${formatBytes(remain)} | 已用: ${formatBytes(used)}`));
    } else {
      infoLinks.push(buildSsInfoLink(`📊 已用: ${formatBytes(used)} | 无限制`));
    }
  }
  const links = [...infoLinks, ...nodes.map(n => buildSsLink(n, n.userPassword))].join('\n');
  return Buffer.from(links).toString('base64');
}

function generateClashSsSub(nodes) {
  const proxies = nodes.map(n => ({
    name: n.name, type: 'ss',
    server: n.host, port: n.port,
    cipher: n.ss_method || 'aes-256-gcm',
    password: n.userPassword || n.ss_password || '',
    udp: true
  }));

  const proxyNames = nodes.map(n => n.name);
  const config = {
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
    proxies,
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', ...proxyNames, 'DIRECT'] },
      { name: '♻️ 自动选择', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 }
    ],
    rules: ['GEOIP,LAN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,🚀 节点选择']
  };
  return clashConfigToYaml(config);
}

function generateSingboxSsSub(nodes) {
  const outbounds = nodes.map(n => ({
    tag: n.name, type: 'shadowsocks',
    server: n.host, server_port: n.port,
    method: n.ss_method || 'aes-256-gcm',
    password: n.userPassword || n.ss_password || ''
  }));

  const tags = nodes.map(n => n.name);
  return JSON.stringify({
    log: { level: 'info' },
    outbounds: [
      { tag: '🚀 节点选择', type: 'selector', outbounds: ['♻️ 自动选择', ...tags, 'direct'] },
      { tag: '♻️ 自动选择', type: 'urltest', outbounds: tags, url: 'http://www.gstatic.com/generate_204', interval: '3m' },
      ...outbounds,
      { tag: 'direct', type: 'direct' },
      { tag: 'block', type: 'block' },
      { tag: 'dns-out', type: 'dns' }
    ],
    route: { auto_detect_interface: true, rules: [{ geoip: ['private', 'cn'], outbound: 'direct' }, { protocol: 'dns', outbound: 'dns-out' }], final: '🚀 节点选择' }
  }, null, 2);
}

function detectClient(ua) {
  if (!ua) return 'v2ray';
  ua = ua.toLowerCase();
  if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash')) return 'clash';
  if (ua.includes('sing-box') || ua.includes('singbox') || ua.includes('sfi') || ua.includes('sfa')) return 'singbox';
  return 'v2ray';
}

function randomPort(min = 10000, max = 60000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateV2raySubForUser(userNodes, trafficInfo) {
  return generateV2raySub(userNodes, trafficInfo);
}

function generateClashSubForUser(userNodes) {
  return generateClashSub(userNodes);
}

function generateSingboxSubForUser(userNodes) {
  return generateSingboxSub(userNodes);
}

module.exports = {
  buildVlessLink, generateV2raySub, generateClashSub, generateSingboxSub,
  generateV2raySubForUser, generateClashSubForUser, generateSingboxSubForUser,
  buildSsLink, generateV2raySsSub, generateClashSsSub, generateSingboxSsSub,
  detectClient, randomPort, formatBytes
};
