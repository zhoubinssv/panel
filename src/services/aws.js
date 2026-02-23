const { EC2Client, DescribeInstancesCommand, AllocateAddressCommand, AssociateAddressCommand, DisassociateAddressCommand, ReleaseAddressCommand, DescribeAddressesCommand, RunInstancesCommand, TerminateInstancesCommand, StartInstancesCommand, StopInstancesCommand, DescribeInstanceStatusCommand } = require('@aws-sdk/client-ec2');
const { LightsailClient, GetInstancesCommand, GetStaticIpsCommand, AllocateStaticIpCommand, AttachStaticIpCommand, DetachStaticIpCommand, ReleaseStaticIpCommand } = require('@aws-sdk/client-lightsail');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { SocksProxyAgent } = require('socks-proxy-agent');
const db = require('./database');
const { encrypt, decrypt } = require('../utils/crypto');

// ========== 配置管理 ==========

function getAwsConfig(accountId) {
  if (accountId) {
    const a = db.getAwsAccountById(accountId);
    if (!a || !a.enabled) return null;
    return {
      accountId: a.id,
      name: a.name,
      accessKey: a.access_key,
      secretKey: a.secret_key,
      defaultRegion: a.default_region || 'us-east-1',
      socks5_host: a.socks5_host,
      socks5_port: a.socks5_port || 1080,
      socks5_user: a.socks5_user,
      socks5_pass: a.socks5_pass
    };
  }

  // 向后兼容旧版单账号 settings
  const accessKey = decrypt(db.getSetting('aws_access_key') || '');
  const secretKey = decrypt(db.getSetting('aws_secret_key') || '');
  const defaultRegion = db.getSetting('aws_default_region') || 'us-east-1';
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey, defaultRegion };
}

function setAwsConfig(cfg) {
  if (!cfg.name) {
    // 保留旧版入口：写入 settings
    if (cfg.accessKey) db.setSetting('aws_access_key', encrypt(cfg.accessKey));
    if (cfg.secretKey) db.setSetting('aws_secret_key', encrypt(cfg.secretKey));
    if (cfg.defaultRegion) db.setSetting('aws_default_region', cfg.defaultRegion);
    return;
  }

  // 新版：写入 aws_accounts
  return db.addAwsAccount({
    name: cfg.name,
    access_key: cfg.accessKey,
    secret_key: cfg.secretKey,
    default_region: cfg.defaultRegion || 'us-east-1',
    socks5_host: cfg.socks5Host,
    socks5_port: cfg.socks5Port || 1080,
    socks5_user: cfg.socks5User,
    socks5_pass: cfg.socks5Pass,
    enabled: true
  });
}

function buildRequestHandler(cfg) {
  if (!cfg?.socks5_host) return undefined;
  const auth = cfg.socks5_user ? `${encodeURIComponent(cfg.socks5_user)}:${encodeURIComponent(cfg.socks5_pass || '')}@` : '';
  const proxyUrl = `socks5://${auth}${cfg.socks5_host}:${cfg.socks5_port || 1080}`;
  return new NodeHttpHandler({
    httpAgent: new SocksProxyAgent(proxyUrl),
    httpsAgent: new SocksProxyAgent(proxyUrl)
  });
}

function getEC2Client(region, accountId) {
  const cfg = getAwsConfig(accountId);
  if (!cfg) throw new Error('AWS 未配置');
  return new EC2Client({
    region: region || cfg.defaultRegion,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    requestHandler: buildRequestHandler(cfg)
  });
}

function getLightsailClient(region, accountId) {
  const cfg = getAwsConfig(accountId);
  if (!cfg) throw new Error('AWS 未配置');
  return new LightsailClient({
    region: region || cfg.defaultRegion,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    requestHandler: buildRequestHandler(cfg)
  });
}

// ========== EC2 操作 ==========

// 列出实例
async function listEC2Instances(region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  const res = await ec2.send(new DescribeInstancesCommand({}));
  const instances = [];
  for (const r of res.Reservations || []) {
    for (const i of r.Instances || []) {
      const nameTag = (i.Tags || []).find(t => t.Key === 'Name');
      instances.push({
        instanceId: i.InstanceId,
        name: nameTag?.Value || '',
        state: i.State?.Name,
        publicIp: i.PublicIpAddress,
        privateIp: i.PrivateIpAddress,
        type: i.InstanceType,
        region: region || getAwsConfig(accountId)?.defaultRegion,
        launchTime: i.LaunchTime
      });
    }
  }
  return instances;
}

// 换 IP（EC2 弹性 IP）：释放旧 EIP → 分配新 EIP → 绑定
async function swapEC2Ip(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);

  // 1. 查找当前绑定的弹性 IP
  const addrRes = await ec2.send(new DescribeAddressesCommand({
    Filters: [{ Name: 'instance-id', Values: [instanceId] }]
  }));
  const oldEip = addrRes.Addresses?.[0];

  // 2. 解绑并释放旧 EIP
  if (oldEip) {
    await ec2.send(new DisassociateAddressCommand({ AssociationId: oldEip.AssociationId }));
    await ec2.send(new ReleaseAddressCommand({ AllocationId: oldEip.AllocationId }));
    console.log(`[AWS] 释放旧 EIP: ${oldEip.PublicIp}`);
  }

  // 3. 分配新 EIP
  const allocRes = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));
  const newIp = allocRes.PublicIp;
  const newAllocId = allocRes.AllocationId;
  console.log(`[AWS] 分配新 EIP: ${newIp}`);

  // 4. 绑定到实例
  await ec2.send(new AssociateAddressCommand({
    InstanceId: instanceId,
    AllocationId: newAllocId
  }));
  console.log(`[AWS] 绑定 ${newIp} → ${instanceId}`);

  return { oldIp: oldEip?.PublicIp, newIp, allocationId: newAllocId };
}

// 终止实例
async function terminateEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

// 启动/停止实例
async function startEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

async function stopEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

// ========== Lightsail 操作 ==========

// 列出 Lightsail 实例
async function listLightsailInstances(region, accountId) {
  const ls = getLightsailClient(region, accountId);
  const res = await ls.send(new GetInstancesCommand({}));
  return (res.instances || []).map(i => ({
    instanceName: i.name,
    state: i.state?.name,
    publicIp: i.publicIpAddress,
    privateIp: i.privateIpAddress,
    staticIp: i.isStaticIp,
    region: i.location?.regionName,
    az: i.location?.availabilityZone,
    blueprintId: i.blueprintId,
    bundleId: i.bundleId
  }));
}

// Lightsail 换 IP：解绑静态 IP → 释放 → 分配新的 → 绑定
async function swapLightsailIp(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);

  // 1. 查找当前绑定的静态 IP
  const ipsRes = await ls.send(new GetStaticIpsCommand({}));
  const oldStaticIp = (ipsRes.staticIps || []).find(ip => ip.attachedTo === instanceName);
  let oldIp = null;

  // 2. 解绑并释放旧静态 IP
  if (oldStaticIp) {
    oldIp = oldStaticIp.ipAddress;
    await ls.send(new DetachStaticIpCommand({ staticIpName: oldStaticIp.name }));
    await ls.send(new ReleaseStaticIpCommand({ staticIpName: oldStaticIp.name }));
    console.log(`[AWS] Lightsail 释放旧 IP: ${oldIp}`);
  }

  // 3. 分配新静态 IP
  const newName = `panel-${instanceName}-${Date.now()}`;
  await ls.send(new AllocateStaticIpCommand({ staticIpName: newName }));

  // 4. 绑定到实例
  await ls.send(new AttachStaticIpCommand({ staticIpName: newName, instanceName }));

  // 5. 获取新 IP 地址
  const newIpsRes = await ls.send(new GetStaticIpsCommand({}));
  const newStaticIp = (newIpsRes.staticIps || []).find(ip => ip.name === newName);
  const newIp = newStaticIp?.ipAddress;

  console.log(`[AWS] Lightsail 新 IP: ${newIp} → ${instanceName}`);
  return { oldIp, newIp, staticIpName: newName };
}

// ========== 节点换 IP 联动 ==========

/**
 * 节点换 IP 完整流程：
 * 1. 调用 AWS 换 IP
 * 2. 更新数据库节点记录
 * 3. 等待 SSH 可用
 * 4. 同步 xray 配置
 */
async function swapNodeIp(node, awsInstanceId, awsType, awsRegion, awsAccountId) {
  const log = [];
  const l = (msg) => { log.push(msg); console.log(`[换IP] ${msg}`); };

  try {
    l(`开始换 IP: ${node.name} (${node.host})`);

    // 1. 换 IP
    let result;
    if (awsType === 'lightsail') {
      result = await swapLightsailIp(awsInstanceId, awsRegion, awsAccountId);
    } else {
      result = await swapEC2Ip(awsInstanceId, awsRegion, awsAccountId);
    }

    if (!result.newIp) throw new Error('未获取到新 IP');
    l(`IP 变更: ${result.oldIp} → ${result.newIp}`);

    // 2. 更新数据库
    db.updateNode(node.id, { host: result.newIp, ssh_host: result.newIp });
    l('数据库已更新');

    // 3. 等待 SSH 可用（最多等 60 秒）
    l('等待 SSH 可用...');
    const { checkPort } = require('./health');
    let sshReady = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      sshReady = await checkPort(result.newIp, node.ssh_port || 22, 5000);
      if (sshReady) break;
    }

    if (!sshReady) {
      l('⚠️ SSH 60秒内未就绪，跳过配置同步');
      return { success: true, newIp: result.newIp, oldIp: result.oldIp, log: log.join('\n'), sshReady: false };
    }
    l('SSH 已就绪');

    // 4. 同步 xray 配置
    const { syncNodeConfig } = require('./deploy');
    const updatedNode = db.getNodeById(node.id);
    const syncOk = await syncNodeConfig(updatedNode, db);
    if (syncOk) {
      l('✅ xray 配置已同步');
      db.updateNode(node.id, { is_active: 1, remark: '' });
    } else {
      l('⚠️ xray 配置同步失败');
    }

    // 5. 审计日志
    db.addAuditLog(null, 'aws_swap_ip', `${node.name} IP变更: ${result.oldIp} → ${result.newIp}`, 'system');

    return { success: true, newIp: result.newIp, oldIp: result.oldIp, log: log.join('\n'), sshReady };

  } catch (e) {
    l(`❌ 换 IP 失败: ${e.message}`);
    return { success: false, error: e.message, log: log.join('\n') };
  }
}

module.exports = {
  getAwsConfig, setAwsConfig,
  listEC2Instances, swapEC2Ip, terminateEC2Instance, startEC2Instance, stopEC2Instance,
  listLightsailInstances, swapLightsailIp,
  swapNodeIp
};
