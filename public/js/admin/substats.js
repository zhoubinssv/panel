/* substats.js — 订阅统计 */

async function loadSubStats(page) {
  page = page || 1;
  const hours = document.getElementById('substats-hours').value;
  const sort = document.getElementById('substats-sort').value;
  const high = document.getElementById('substats-high').checked ? '1' : '0';
  const container = document.getElementById('substats-result');
  const pager = document.getElementById('substats-pager');
  container.innerHTML = '<p class="text-gray-500 text-sm text-center py-2">加载中...</p>';
  pager.innerHTML = '';
  try {
    const res = await fetch('/admin/api/sub-stats?hours=' + hours + '&page=' + page + '&sort=' + sort + '&high=' + high);
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      container.innerHTML = '<p class="text-emerald-400 text-sm text-center py-4">✅ 无数据</p>';
      return;
    }
    const riskBadge = r => {
      const cls = r === 'high' ? 'bg-red-500/20 text-red-300' : r === 'mid' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-gray-400';
      return '<span class="text-xs px-2 py-0.5 rounded-full ' + cls + '">' + escapeHtml(r) + '</span>';
    };
    container.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-xs">' +
      '<thead><tr class="text-gray-500 border-b border-white/10"><th class="py-2 text-left">用户</th><th>拉取</th><th>IP数</th><th>最近拉取</th><th>平均间隔</th><th>风险</th><th></th></tr></thead><tbody>' +
      json.data.map(u =>
        '<tr class="border-b border-white/5 hover:bg-white/5">' +
        '<td class="py-2 text-white">' + escapeHtml(u.username) + ' <span class="text-gray-600">ID:' + escapeHtml(u.user_id) + '</span></td>' +
        '<td class="text-center text-gray-300">' + escapeHtml(u.pull_count) + '</td>' +
        '<td class="text-center text-gray-300">' + escapeHtml(u.ip_count) + '</td>' +
        '<td class="text-center text-gray-400">' + escapeHtml(u.last_access || '-') + '</td>' +
        '<td class="text-center text-gray-400">' + escapeHtml(u.avg_interval_sec) + 's</td>' +
        '<td class="text-center">' + riskBadge(u.risk_level) + '</td>' +
        '<td class="text-right"><button onclick="showSubStatDetail(' + parseInt(u.user_id) + ',' + parseInt(hours) + ')" class="text-rose-400 hover:text-rose-300">详情</button></td></tr>'
      ).join('') + '</tbody></table></div>';
    const totalPages = Math.ceil(json.total / json.limit);
    if (totalPages > 1) {
      let html = '';
      for (let i = 1; i <= totalPages && i <= 10; i++) {
        html += '<button onclick="loadSubStats(' + i + ')" class="text-xs px-2 py-1 rounded ' + (i === page ? 'bg-rose-600 text-white' : 'bg-white/10 text-gray-400') + '">' + i + '</button>';
      }
      pager.innerHTML = html;
    }
  } catch (e) { container.innerHTML = '<p class="text-red-400 text-sm">加载失败</p>'; }
}

async function showSubStatDetail(userId, hours) {
  const panel = document.getElementById('substats-detail-panel');
  const container = document.getElementById('substats-detail');
  panel.classList.remove('hidden');
  container.innerHTML = '<p class="text-gray-500 text-xs">加载中...</p>';
  try {
    const res = await fetch('/admin/api/sub-stats/' + userId + '/detail?hours=' + hours);
    const d = await res.json();
    let html = '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">';
    html += '<div><h4 class="text-gray-400 text-xs mb-2">IP 分布 (' + escapeHtml(d.ips.length) + ')</h4><div class="space-y-1">' +
      d.ips.map(ip => '<div class="flex justify-between p-1.5 rounded bg-black/20 text-xs"><span class="text-gray-300 font-mono">' + escapeHtml(ip.ip) + '</span><span class="text-gray-500">' + escapeHtml(ip.count) + '次 ' + escapeHtml(ip.last_access) + '</span></div>').join('') + '</div></div>';
    html += '<div><h4 class="text-gray-400 text-xs mb-2">UA TOP</h4><div class="space-y-1">' +
      d.uas.map(ua => '<div class="p-1.5 rounded bg-black/20 text-xs"><span class="text-gray-300 break-all">' + escapeHtml(ua.ua || '(empty)') + '</span> <span class="text-gray-500">' + escapeHtml(ua.count) + '次</span></div>').join('') + '</div></div>';
    html += '<div><h4 class="text-gray-400 text-xs mb-2">最近拉取</h4><div class="space-y-1">' +
      d.timeline.map(t => '<div class="p-1.5 rounded bg-black/20 text-xs"><span class="text-gray-400">' + escapeHtml(t.time) + '</span> <span class="text-gray-300 font-mono">' + escapeHtml(t.ip) + '</span></div>').join('') + '</div></div>';
    html += '</div>';
    container.innerHTML = html;
    document.getElementById('substats-detail-title').textContent = '用户 #' + userId + ' 详情';
  } catch (e) { container.innerHTML = '<p class="text-red-400 text-xs">加载失败</p>'; }
}

async function checkAbuse() { loadSubStats(1); }
function loadAbuse() { loadSubStats(1); }

async function showDetail(userId, hours) {
  const panel = document.getElementById('substats-detail-panel');
  const container = document.getElementById('substats-detail');
  panel.classList.remove('hidden');
  container.innerHTML = '<p class="text-gray-500 text-xs">加载中...</p>';
  const res = await fetch('/admin/api/sub-access/' + userId + '?hours=' + hours);
  const ips = await res.json();
  container.innerHTML = '<div class="space-y-1">' + ips.map(ip =>
    '<div class="flex items-center justify-between p-2 rounded-lg bg-black/20 text-xs">' +
    '<span class="text-gray-300 font-mono">' + escapeHtml(ip.ip) + '</span>' +
    '<div class="flex gap-3"><span class="text-gray-500">拉取 ' + escapeHtml(ip.count) + ' 次</span><span class="text-gray-600">' + escapeHtml(ip.last_access) + '</span></div></div>'
  ).join('') + '</div>';
}
