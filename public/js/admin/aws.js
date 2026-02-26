/* aws.js — AWS 账号管理、实例仪表盘、绑定/解绑、新建实例 */

window._awsAccounts = [];

async function loadAwsConfig() {
  const res = await fetch('/admin/api/aws/config');
  const cfg = await res.json();
  window._awsAccounts = cfg.accounts || [];
  const el = document.getElementById('aws-status');
  const list = document.getElementById('aws-accounts');
  const bindSel = document.getElementById('bind-account-id');

  if (cfg.configured) {
    el.textContent = '✅ ' + cfg.count + ' 个账号';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-white/10 text-gray-300';
  } else {
    el.textContent = '未配置';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400';
  }

  list.innerHTML = (cfg.accounts || []).map(a =>
    '<div class="flex items-center justify-between rounded-xl bg-black/20 border border-white/5 px-3 py-2.5">' +
    '<div class="min-w-0"><div class="text-xs text-white font-medium truncate">#' + escapeHtml(a.id) + ' ' + escapeHtml(a.name) + '</div>' +
    '<div class="text-[11px] text-gray-500 mt-0.5 truncate">' + escapeHtml(a.accessKeyMasked) + (a.socks5_host ? ' · SOCKS ' + escapeHtml(a.socks5_host) + ':' + escapeHtml(a.socks5_port) : '') + '</div></div>' +
    '<div class="flex items-center gap-2">' +
    '<button type="button" class="text-gray-300 hover:text-white text-xs px-2 py-1 rounded-lg bg-white/5 border border-white/10" onclick="editAwsAccount(' + parseInt(a.id) + ')">编辑</button>' +
    '<button type="button" class="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20" onclick="deleteAwsAccount(' + parseInt(a.id) + ')">删除</button>' +
    '</div></div>'
  ).join('') || '<p class="text-gray-500 text-xs">暂无 AWS 账号</p>';

  bindSel.innerHTML = (cfg.accounts || []).map(a => '<option value="' + escapeHtml(a.id) + '">#' + escapeHtml(a.id) + ' ' + escapeHtml(a.name) + '</option>').join('');
}

async function saveAwsConfig() {
  const name = document.getElementById('aws-name').value.trim();
  const ak = document.getElementById('aws-ak').value.trim();
  const sk = document.getElementById('aws-sk').value.trim();
  const socks5Url = document.getElementById('aws-socks-url').value.trim();
  if (!name) { toast('请填写账号名', 2500, 'error'); return; }
  if (!ak) { toast('请填写 Access Key', 2500, 'error'); return; }
  if (!sk) { toast('请填写 Secret Key', 2500, 'error'); return; }

  const res = await fetch('/admin/api/aws/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, accessKey: ak, secretKey: sk, socks5Url })
  });
  if (res.ok) {
    showToast('✅ AWS 账号已新增');
    ['aws-name', 'aws-ak', 'aws-sk', 'aws-socks-url'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('aws-socks-test-result').textContent = '';
    loadAwsConfig();
  } else {
    const d = await res.json().catch(() => ({}));
    showToast('❌ ' + (d.error || '保存失败'));
  }
}

async function testSocksProxyInput(inputId, resultId) {
  const socks5Url = document.getElementById(inputId).value.trim();
  const resultEl = document.getElementById(resultId);
  if (!socks5Url) { showToast('请先填写 SOCKS5 URL'); return; }
  resultEl.textContent = '验证中...';
  const res = await fetch('/admin/api/aws/socks-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ socks5Url })
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.ok) {
    resultEl.textContent = '✅ 代理可用，出口 IP: ' + d.ip;
    resultEl.className = 'text-[11px] text-emerald-400 mt-1';
  } else {
    resultEl.textContent = '❌ 验证失败: ' + (d.error || '未知错误');
    resultEl.className = 'text-[11px] text-red-400 mt-1';
  }
}

async function testSocksProxy() {
  return testSocksProxyInput('aws-socks-url', 'aws-socks-test-result');
}

async function deleteAwsAccount(id) {
  if (!await _confirm('确定删除该 AWS 账号？')) return;
  const res = await fetch('/admin/api/aws/config/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  if (res.ok) { showToast('✅ 已删除账号'); loadAwsConfig(); }
  else showToast('❌ 删除失败');
}

function editAwsAccount(id) {
  const a = (window._awsAccounts || []).find(x => x.id === id);
  if (!a) { showToast('账号不存在'); return; }
  document.getElementById('edit-aws-id').value = id;
  document.getElementById('edit-aws-name').value = a.name || '';
  document.getElementById('edit-aws-ak').value = a.accessKeyMasked || '';
  document.getElementById('edit-aws-socks').value = a.socks5_host ? 'socks5://' + a.socks5_host + ':' + (a.socks5_port || 1080) : '';
  document.getElementById('edit-aws-socks-test').textContent = '';
  document.getElementById('aws-edit-modal').classList.remove('hidden');
}

function closeAwsEditModal() {
  document.getElementById('aws-edit-modal').classList.add('hidden');
}

async function saveAwsEdit() {
  const id = parseInt(document.getElementById('edit-aws-id').value);
  const name = document.getElementById('edit-aws-name').value.trim();
  const socks5Url = document.getElementById('edit-aws-socks').value.trim();
  if (!id) { showToast('参数错误'); return; }
  if (!name) { showToast('账号名不能为空'); return; }
  const res = await fetch('/admin/api/aws/config/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, socks5Url })
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok) { showToast('✅ 账号已更新'); closeAwsEditModal(); loadAwsConfig(); }
  else showToast('❌ ' + (d.error || '更新失败'));
}

function showBindAws(nodeId) {
  document.getElementById('bind-node-id').value = nodeId;
  if (!window._awsAccounts || window._awsAccounts.length === 0) { showToast('请先新增 AWS 账号'); return; }
  document.getElementById('aws-bind-modal').classList.remove('hidden');
}

async function confirmBindAws() {
  const nodeId = document.getElementById('bind-node-id').value;
  const data = {
    aws_account_id: parseInt(document.getElementById('bind-account-id').value),
    aws_instance_id: document.getElementById('bind-instance-id').value.trim(),
    aws_type: document.getElementById('bind-type').value,
    aws_region: document.getElementById('bind-region').value || null
  };
  if (!data.aws_account_id) { showToast('请选择 AWS 账号'); return; }
  if (!data.aws_instance_id) { showToast('请填写实例 ID'); return; }
  const res = await fetch('/admin/api/nodes/' + nodeId + '/aws-bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (res.ok) { showToast('✅ 已绑定'); document.getElementById('aws-bind-modal').classList.add('hidden'); location.hash = 'aws'; location.reload(); }
  else showToast('❌ 绑定失败');
}

async function unbindAws(nodeId) {
  if (!await _confirm('确定解绑？')) return;
  const res = await fetch('/admin/api/nodes/' + nodeId + '/aws-bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aws_instance_id: null, aws_type: null, aws_region: null, aws_account_id: null }) });
  if (res.ok) { showToast('✅ 已解绑'); location.hash = 'aws'; location.reload(); }
}

async function swapNodeIp(nodeId, nodeName, btn) {
  if (!await _confirm('确定给 ' + nodeName + ' 换 IP？将释放旧 IP 并分配新 IP')) return;
  const done = btnLoading(btn, '🔄 换IP中...');
  try {
    const res = await fetch('/admin/api/nodes/' + nodeId + '/swap-ip', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (data.success) { toast('✅ 换 IP 成功: ' + data.newIp); setTimeout(() => { location.hash = 'aws'; location.reload(); }, 1500); }
    else toast('❌ ' + (data.error || '换 IP 失败'), 3000, 'error');
  } catch (e) { toast('❌ 网络错误', 3000, 'error'); }
  done();
}

async function loadAllInstances(force) {
  const loading = document.getElementById('aws-instances-loading');
  const container = document.getElementById('aws-instances-container');
  loading.classList.remove('hidden');
  container.classList.add('hidden');
  try {
    const res = await fetch('/admin/api/aws/all-instances' + (force ? '?force=1' : ''));
    const accounts = await res.json();
    if (!res.ok) throw new Error(accounts.error || '加载失败');

    // 区域友好名映射
    const regionNames = {
      'us-east-1': '🇺🇸 弗吉尼亚', 'us-east-2': '🇺🇸 俄亥俄', 'us-west-1': '🇺🇸 加州', 'us-west-2': '🇺🇸 俄勒冈',
      'ap-northeast-1': '🇯🇵 东京', 'ap-northeast-2': '🇰🇷 首尔', 'ap-northeast-3': '🇯🇵 大阪',
      'ap-southeast-1': '🇸🇬 新加坡', 'ap-southeast-2': '🇦🇺 悉尼', 'ap-south-1': '🇮🇳 孟买', 'ap-east-1': '🇭🇰 香港',
      'eu-west-1': '🇮🇪 爱尔兰', 'eu-west-2': '🇬🇧 伦敦', 'eu-central-1': '🇩🇪 法兰克福',
      'ca-central-1': '🇨🇦 多伦多', 'sa-east-1': '🇧🇷 圣保罗'
    };

    let html = '';
    for (const acc of accounts) {
      if (acc.instances.length === 0) continue;
      html += '<div class="mb-4">' +
        '<div class="text-[11px] text-gray-500 mb-2 px-1">📦 ' + escapeHtml(acc.accountName) + ' <span class="text-gray-600">#' + escapeHtml(acc.accountId) + '</span></div>';

      // 按区域分组
      const byRegion = {};
      for (const inst of acc.instances) {
        const r = inst.region || 'unknown';
        if (!byRegion[r]) byRegion[r] = [];
        byRegion[r].push(inst);
      }

      for (const [region, instances] of Object.entries(byRegion)) {
        const regionLabel = regionNames[region] || '🌐 ' + region;
        html += '<div class="mb-3"><div class="text-[10px] text-gray-600 mb-1.5 px-1">' + regionLabel + '</div>' +
          '<div class="rounded-xl border border-white/5 overflow-hidden divide-y divide-white/5">';

        for (const inst of instances) {
          const isBlocked = inst.boundNode && (inst.boundNode.remark?.includes('被墙') || inst.boundNode.remark?.includes('离线') || !inst.boundNode.is_active);
          const stateDot = inst.state === 'running' ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]' : inst.state === 'stopped' ? 'bg-gray-600' : 'bg-yellow-400';
          const rowBg = isBlocked ? 'bg-red-500/5' : 'bg-white/[0.02] hover:bg-white/[0.04]';
          const safeInstId = escapeHtml(inst.instanceId);
          const safeInstType = escapeHtml(inst.instanceType);
          const safeRegion = escapeHtml(inst.region);
          const safeAccId = parseInt(inst.accountId) || 0;
          const typeBadge = inst.instanceType === 'lightsail'
            ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400/80">LS</span>'
            : '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400/80">EC2</span>';

          html += '<div class="' + rowBg + ' px-3 py-2 transition-colors">' +
            '<div class="flex items-center justify-between gap-2">' +
            // 左侧：状态点 + 名称 + 类型
            '<div class="flex items-center gap-2 min-w-0 flex-1">' +
            '<span class="inline-block w-1.5 h-1.5 rounded-full ' + stateDot + ' flex-shrink-0"></span>' +
            '<span class="text-[11px] text-white/90 font-medium truncate">' + escapeHtml(inst.name || inst.instanceId) + '</span>' +
            typeBadge +
            '</div>' +
            // 右侧：IP + 节点 + 操作按钮
            '<div class="flex items-center gap-2 flex-shrink-0">' +
            (inst.publicIp ? '<span class="text-[10px] text-blue-400/70 font-mono">' + escapeHtml(inst.publicIp) + '</span>' : '<span class="text-[10px] text-gray-700 italic">无 IP</span>') +
            (inst.boundNode ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400/80">🔗 ' + escapeHtml(inst.boundNode.name) + '</span>' : '') +
            (isBlocked ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">⚠️</span>' : '') +
            // 操作按钮组
            '<div class="flex items-center gap-0.5">' +
            (inst.state === 'stopped' ? '<button onclick="awsInstanceAction(\'start\',\'' + safeInstId + '\',\'' + safeInstType + '\',\'' + safeRegion + '\',' + safeAccId + ')" class="text-[10px] w-6 h-6 flex items-center justify-center rounded-lg hover:bg-emerald-500/20 text-emerald-400/60 hover:text-emerald-300 transition-colors" title="开机">▶</button>' : '') +
            (inst.state === 'running' ? '<button onclick="awsInstanceAction(\'stop\',\'' + safeInstId + '\',\'' + safeInstType + '\',\'' + safeRegion + '\',' + safeAccId + ')" class="text-[10px] w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-500/20 text-gray-500 hover:text-gray-300 transition-colors" title="关机">⏹</button>' : '') +
            (inst.state === 'running' ? '<button onclick="awsInstanceAction(\'swap-ip\',\'' + safeInstId + '\',\'' + safeInstType + '\',\'' + safeRegion + '\',' + safeAccId + ')" class="text-[10px] w-6 h-6 flex items-center justify-center rounded-lg ' + (isBlocked ? 'hover:bg-red-500/20 text-red-400 hover:text-red-300' : 'hover:bg-amber-500/20 text-amber-500/60 hover:text-amber-300') + ' transition-colors" title="换IP">🔄</button>' : '') +
            '<button onclick="awsInstanceAction(\'terminate\',\'' + safeInstId + '\',\'' + safeInstType + '\',\'' + safeRegion + '\',' + safeAccId + ')" class="text-[10px] w-6 h-6 flex items-center justify-center rounded-lg hover:bg-red-500/20 text-red-500/40 hover:text-red-300 transition-colors" title="终止">🗑</button>' +
            '</div>' +
            '</div>' +
            '</div></div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    if (!html) html = '<p class="text-gray-500 text-xs text-center py-4">暂无实例</p>';
    container.innerHTML = html;
    loading.classList.add('hidden');
    container.classList.remove('hidden');
  } catch (e) {
    loading.textContent = '❌ ' + e.message;
  }
}

async function awsInstanceAction(action, instanceId, type, region, accountId) {
  const actionNames = { start: '开机', stop: '关机', terminate: '终止', 'swap-ip': '换 IP' };
  if (action === 'terminate') {
    if (!await _confirm('确定终止实例 ' + instanceId + '？此操作不可恢复！')) return;
  } else if (action === 'swap-ip') {
    if (!await _confirm('确定给 ' + instanceId + ' 换 IP？')) return;
  }
  showToast('⏳ ' + actionNames[action] + '中...');
  try {
    const res = await fetch('/admin/api/aws/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId, type, region, accountId })
    });
    const data = await res.json();
    if (res.ok && (data.ok || data.success)) {
      showToast('✅ ' + actionNames[action] + '成功' + (data.newIp ? ' 新IP: ' + data.newIp : ''));
      setTimeout(() => loadAllInstances(true), 2000);
    } else {
      showToast('❌ ' + (data.error || '操作失败'));
    }
  } catch (e) { showToast('❌ 网络错误'); }
}

function showLaunchModal() {
  if (!window._awsAccounts || window._awsAccounts.length === 0) { showToast('请先新增 AWS 账号'); return; }
  const sel = document.getElementById('launch-account-id');
  sel.innerHTML = window._awsAccounts.map(a => '<option value="' + escapeHtml(a.id) + '">#' + escapeHtml(a.id) + ' ' + escapeHtml(a.name) + '</option>').join('');
  updateLaunchSpecs();
  document.getElementById('aws-launch-modal').classList.remove('hidden');
}

function updateLaunchSpecs() {
  const type = document.getElementById('launch-type').value;
  const sel = document.getElementById('launch-spec');
  if (type === 'lightsail') {
    sel.innerHTML = '<option value="nano_3_0">nano (512MB/$3.5)</option><option value="micro_3_0">micro (1GB/$5)</option><option value="small_3_0">small (2GB/$10)</option><option value="medium_3_0">medium (4GB/$20)</option>';
  } else {
    sel.innerHTML = '<option value="t4g.micro">t4g.micro (1C/1G)</option><option value="t4g.small">t4g.small (2C/2G)</option><option value="t4g.medium">t4g.medium (2C/4G)</option>';
  }
}

async function confirmLaunch() {
  const accountId = document.getElementById('launch-account-id').value;
  const region = document.getElementById('launch-region').value;
  const type = document.getElementById('launch-type').value;
  const spec = document.getElementById('launch-spec').value;
  const sshPassword = document.getElementById('launch-ssh-password').value;
  if (!sshPassword) { showToast('请填写 SSH 密码'); return; }
  const btn = document.getElementById('launch-btn');
  btn.disabled = true; btn.textContent = '⏳ 创建中...';
  try {
    const res = await fetch('/admin/api/aws/launch-and-deploy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: parseInt(accountId), region, type, spec, sshPassword })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('🚀 正在后台创建并部署，请稍后刷新查看');
      document.getElementById('aws-launch-modal').classList.add('hidden');
    } else {
      showToast('❌ ' + (data.error || '创建失败'));
    }
  } catch (e) { showToast('❌ 网络错误'); }
  btn.disabled = false; btn.textContent = '🚀 创建并部署';
}
