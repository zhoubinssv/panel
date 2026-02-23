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
  return `vless://${uuid || node.uuid}@${node.host}:${node.port}?${params}#${node.name.replace(/ /g, '%20')}`;
}

// v2ray 订阅（base64 编码的链接列表）
function generateV2raySub(nodes) {
  const links = nodes.map(n => buildVlessLink(n)).join('\n');
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

module.exports = {
  buildVlessLink, generateV2raySub, generateClashSub, generateSingboxSub,
  generateV2raySubForUser: generateV2raySub,
  generateClashSubForUser: generateClashSub,
  generateSingboxSubForUser: generateSingboxSub,
  detectClient, randomPort
};
