/* traffic.js — 流量统计相关 */

let currentRange = 'today';
let trafficChart = null;

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function switchRange(range) {
  currentRange = range;
  document.querySelectorAll('#traffic-range-btns button').forEach(btn => {
    btn.className = btn.dataset.range === range
      ? 'text-[11px] px-2.5 py-1 rounded-lg transition bg-rose-600 text-white'
      : 'text-[11px] px-2.5 py-1 rounded-lg transition glass text-gray-400 hover:text-white';
  });
  if (range === 'date') {
    document.querySelectorAll('#traffic-range-btns button').forEach(btn => {
      btn.className = 'text-[11px] px-2.5 py-1 rounded-lg transition glass text-gray-400 hover:text-white';
    });
  }
  loadTraffic(1);
}

function _buildTrafficRow(cells, classes) {
  const tr = document.createElement('tr');
  tr.className = 'border-b border-white/5 hover:bg-white/[0.02]';
  cells.forEach((text, idx) => {
    const td = document.createElement('td');
    td.className = classes[idx];
    td.textContent = text;
    tr.appendChild(td);
  });
  return tr;
}

async function loadTraffic(page) {
  let url;
  if (currentRange === 'date') {
    const date = document.getElementById('traffic-date').value;
    url = '/admin/api/traffic?date=' + date + '&page=' + page;
  } else {
    url = '/admin/api/traffic?range=' + currentRange + '&page=' + page;
  }
  const res = await fetch(url);
  const d = await res.json();
  const body = document.getElementById('traffic-body');
  const offset = (d.page - 1) * 20;
  body.innerHTML = '';
  if (d.rows.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="py-6 px-4 text-gray-600 text-xs text-center">该时段暂无流量数据</td></tr>';
  } else {
    d.rows.forEach((u, i) => {
      body.appendChild(_buildTrafficRow(
        [offset + i + 1, u.username, fmtBytes(u.total_up), fmtBytes(u.total_down), fmtBytes(u.total_up + u.total_down)],
        ['py-2 px-4 text-[11px] text-gray-500', 'py-2 px-4 text-xs text-white', 'py-2 px-4 text-xs', 'py-2 px-4 text-xs', 'py-2 px-4 text-xs font-medium text-rose-400']
      ));
    });
  }
  document.getElementById('traffic-info').textContent = '共 ' + d.total + ' 人';
  const pager = document.getElementById('traffic-pager');
  pager.innerHTML = '';
  for (let i = 1; i <= d.pages; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    btn.className = 'text-xs px-2 py-1 rounded ' + (i === d.page ? 'bg-rose-600 text-white' : 'glass text-gray-400 hover:text-white');
    btn.onclick = () => loadTraffic(i);
    pager.appendChild(btn);
  }
  loadNodeTraffic();
}

async function loadNodeTraffic() {
  const rangeParam = currentRange === 'date' ? document.getElementById('traffic-date').value : currentRange;
  const res = await fetch('/admin/api/traffic/nodes?range=' + rangeParam);
  const d = await res.json();
  const body = document.getElementById('node-traffic-body');
  body.innerHTML = '';
  if (d.rows.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="py-6 px-4 text-gray-600 text-xs text-center">暂无节点流量数据</td></tr>';
  } else {
    d.rows.forEach((n, i) => {
      body.appendChild(_buildTrafficRow(
        [i + 1, n.name, fmtBytes(n.total_up), fmtBytes(n.total_down), fmtBytes(n.total_up + n.total_down)],
        ['py-2 px-4 text-[11px] text-gray-500', 'py-2 px-4 text-xs text-white', 'py-2 px-4 text-xs', 'py-2 px-4 text-xs', 'py-2 px-4 text-xs font-medium text-rose-400']
      ));
    });
  }
}

async function loadTrafficChart() {
  try {
    const res = await fetch('/admin/api/traffic/trend?days=30');
    const data = await res.json();
    const ctx = document.getElementById('traffic-chart');
    if (!ctx) return;
    if (trafficChart) trafficChart.destroy();
    const labels = data.map(d => d.date.slice(5));
    const toGB = v => +(v / 1073741824).toFixed(2);
    trafficChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '上传 (GB)', data: data.map(d => toGB(d.total_up)), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
          { label: '下载 (GB)', data: data.map(d => toGB(d.total_down)), borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3, pointRadius: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#9ca3af', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
          y: { ticks: { color: '#6b7280', font: { size: 10 }, callback: v => v + ' GB' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  } catch (e) { console.error('chart error', e); }
}

// 初始加载节点流量
document.addEventListener('DOMContentLoaded', () => loadNodeTraffic());
if (location.hash === '#traffic') setTimeout(loadTrafficChart, 200);
