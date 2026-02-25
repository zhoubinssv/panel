const { EC2Client, DescribeInstancesCommand, AllocateAddressCommand, AssociateAddressCommand, DisassociateAddressCommand, ReleaseAddressCommand, DescribeAddressesCommand, RunInstancesCommand, TerminateInstancesCommand, StartInstancesCommand, StopInstancesCommand, DescribeInstanceStatusCommand, DescribeImagesCommand, CreateTagsCommand } = require('@aws-sdk/client-ec2');
const { LightsailClient, GetInstancesCommand, GetStaticIpsCommand, AllocateStaticIpCommand, AttachStaticIpCommand, DetachStaticIpCommand, ReleaseStaticIpCommand, CreateInstancesCommand, DeleteInstanceCommand, StartInstanceCommand, StopInstanceCommand } = require('@aws-sdk/client-lightsail');
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
    const { checkPort } = require('./health'); // 延迟加载避免循环依赖
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
    const { syncNodeConfig } = require('./deploy'); // 延迟加载避免循环依赖
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

// ========== Lightsail 启停/终止 ==========

async function startLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new StartInstanceCommand({ instanceName }));
  return true;
}

async function stopLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new StopInstanceCommand({ instanceName }));
  return true;
}

async function terminateLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new DeleteInstanceCommand({ instanceName, forceDeleteAddOns: true }));
  return true;
}

// ========== 获取最新 Ubuntu ARM64 AMI ==========

async function getLatestUbuntuAmi(region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  const res = await ec2.send(new DescribeImagesCommand({
    Filters: [
      { Name: 'name', Values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['arm64'] }
    ],
    Owners: ['099720109477'] // Canonical
  }));
  const images = (res.Images || []).sort((a, b) => (b.CreationDate || '').localeCompare(a.CreationDate || ''));
  if (images.length === 0) throw new Error('未找到 Ubuntu ARM64 AMI');
  return images[0].ImageId;
}

// ========== 创建实例 ==========

async function launchEC2Instance(region, instanceType, accountId) {
  const ec2 = getEC2Client(region, accountId);
  const amiId = await getLatestUbuntuAmi(region, accountId);

  const res = await ec2.send(new RunInstancesCommand({
    ImageId: amiId,
    InstanceType: instanceType || 't4g.micro',
    MinCount: 1,
    MaxCount: 1,
    // 使用默认 VPC 和安全组，需要公网 IP
    NetworkInterfaces: [{
      DeviceIndex: 0,
      AssociatePublicIpAddress: true,
      Groups: [] // 使用默认安全组
    }]
  }));

  const instance = res.Instances?.[0];
  if (!instance) throw new Error('EC2 创建失败');
  return { instanceId: instance.InstanceId, state: instance.State?.Name };
}

async function launchLightsailInstance(region, bundleId, instanceName, accountId) {
  const ls = getLightsailClient(region, accountId);
  const az = region + 'a'; // 默认用 a 可用区
  await ls.send(new CreateInstancesCommand({
    instanceNames: [instanceName],
    availabilityZone: az,
    blueprintId: 'ubuntu_22_04',
    bundleId: bundleId || 'nano_3_0',
  }));
  return { instanceName, state: 'pending' };
}

// ========== 等待实例就绪 ==========

async function waitForInstanceRunning(instanceId, type, region, accountId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (type === 'lightsail') {
        const instances = await listLightsailInstances(region, accountId);
        const inst = instances.find(i => i.instanceName === instanceId);
        if (inst?.state === 'running') return inst;
      } else {
        const instances = await listEC2Instances(region, accountId);
        const inst = instances.find(i => i.instanceId === instanceId);
        if (inst?.state === 'running' && inst?.publicIp) return inst;
      }
    } catch (e) {
      console.log(`[等待实例] 查询失败: ${e.message}`);
    }
  }
  throw new Error('等待实例就绪超时');
}

// ========== 实例标签 ==========

async function tagInstance(instanceId, tags, type, region, accountId) {
  if (type === 'lightsail') {
    // Lightsail 不支持 CreateTags，跳过
    return;
  }
  const ec2 = getEC2Client(region, accountId);
  const ec2Tags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  await ec2.send(new CreateTagsCommand({
    Resources: [instanceId],
    Tags: ec2Tags
  }));
}

// ========== 获取所有账号的所有实例 ==========

async function listAllInstances() {
  const accounts = db.getAwsAccounts(true); // 只获取启用的
  const allNodes = db.getAllNodes();
  // 构建节点映射: accountId:aws_instance_id -> node
  const nodeMap = {};
  for (const n of allNodes) {
    if (n.aws_instance_id && n.aws_account_id) {
      nodeMap[`${n.aws_account_id}:${n.aws_instance_id}`] = n;
    }
  }

  const results = [];
  // 常用区域列表
  const REGIONS = ['us-east-1', 'us-west-2', 'ap-northeast-1', 'ap-southeast-1', 'ap-south-1', 'eu-west-1', 'eu-central-1', 'ap-east-1', 'ap-southeast-2', 'ca-central-1', 'sa-east-1'];

  for (const account of accounts) {
    const accountResult = { accountId: account.id, accountName: account.name, instances: [] };
    // 每个账号查询所有区域
    const regionList = [account.default_region || 'us-east-1', ...REGIONS.filter(r => r !== (account.default_region || 'us-east-1'))];
    const uniqueRegions = [...new Set(regionList)];

    const promises = uniqueRegions.map(async (region) => {
      const regionInstances = [];
      try {
        const ec2List = await listEC2Instances(region, account.id);
        for (const inst of ec2List) {
          const node = nodeMap[`${account.id}:${inst.instanceId}`];
          regionInstances.push({
            ...inst,
            instanceType: 'ec2',
            ec2Type: inst.type,
            accountId: account.id,
            accountName: account.name,
            boundNode: node ? { id: node.id, name: node.name, host: node.host, remark: node.remark, is_active: node.is_active } : null
          });
        }
      } catch (e) { /* 区域无权限等忽略 */ }
      try {
        const lsList = await listLightsailInstances(region, account.id);
        for (const inst of lsList) {
          const node = nodeMap[`${account.id}:${inst.instanceName}`];
          regionInstances.push({
            instanceId: inst.instanceName,
            name: inst.instanceName,
            state: inst.state,
            publicIp: inst.publicIp,
            region: inst.region || region,
            instanceType: 'lightsail',
            bundleId: inst.bundleId,
            accountId: account.id,
            accountName: account.name,
            boundNode: node ? { id: node.id, name: node.name, host: node.host, remark: node.remark, is_active: node.is_active } : null
          });
        }
      } catch (e) { /* 忽略 */ }
      return regionInstances;
    });

    const regionResults = await Promise.all(promises);
    for (const ri of regionResults) {
      accountResult.instances.push(...ri);
    }
    // 过滤掉 terminated 实例
    accountResult.instances = accountResult.instances.filter(i => i.state !== 'terminated');
    results.push(accountResult);
  }

  return results;
}

module.exports = {
  getAwsConfig, setAwsConfig,
  listEC2Instances, swapEC2Ip, terminateEC2Instance, startEC2Instance, stopEC2Instance,
  listLightsailInstances, swapLightsailIp,
  startLightsailInstance, stopLightsailInstance, terminateLightsailInstance,
  swapNodeIp,
  getLatestUbuntuAmi, launchEC2Instance, launchLightsailInstance,
  waitForInstanceRunning, tagInstance, listAllInstances
};
