/**
 * Lightweight web dashboard untuk admin monitoring.
 *
 * Zero-dep: pakai Node.js http module built-in (tidak install Express).
 * Route:
 *   GET /            — redirect to /admin
 *   GET /admin       — HTML dashboard (with basic auth)
 *   GET /admin/api   — JSON data untuk refresh via fetch
 *
 * Auth: basic auth dengan env DASHBOARD_USER + DASHBOARD_PASS.
 * Kalau kedua env tidak di-set, dashboard OFF (tidak bind port).
 * Bind default 127.0.0.1:3000 (local only); expose via reverse proxy kalau mau public.
 *
 * Port configurable via DASHBOARD_PORT, bind via DASHBOARD_HOST.
 */

const http = require('http');
const os = require('os');

function timingSafeEqual(a, b) {
  // Naive but constant-time-ish comparison
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const [user, ...rest] = decoded.split(':');
    return { user, pass: rest.join(':') };
  } catch (_) {
    return null;
  }
}

function checkAuth(req) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return true; // kalau tidak di-set, skip auth (local dev)
  const creds = parseBasicAuth(req.headers['authorization']);
  if (!creds) return false;
  return timingSafeEqual(creds.user, user) && timingSafeEqual(creds.pass, pass);
}

function unauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="CosTeleBot Dashboard"',
    'Content-Type': 'text/plain',
  });
  res.end('401 Unauthorized');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Build JSON payload dengan current bot state.
 * Dependencies di-inject via constructor: bot, queueManager, botStats, statsDb.
 */
function buildStateJson(deps) {
  const { botStats, queueManager, statsDbRead } = deps;
  const activeJobs = Array.from(queueManager.activeJobs.values()).map(j => ({
    id: j.id,
    chatId: j.chatId,
    title: j.title,
    progress: j.progress,
    status: j.status,
  }));
  const pendingPerUser = queueManager.snapshotQueues();

  // Read stats.json untuk per-user breakdown
  let users = {};
  try { users = statsDbRead() || {}; } catch (_) { }
  const now = Date.now();
  const tierOf = (s) => (s.premiumUntil && s.premiumUntil > now) ? (s.premiumTier === 'vvip' ? 'vvip' : 'premium') : 'free';
  const userList = Object.entries(users).map(([chatId, s]) => ({
    chatId,
    gachaCasts: s.gachaCasts || 0,
    downloadBytes: s.downloadBytes || 0,
    joinDate: s.joinDate || null,
    tier: tierOf(s),
    premiumUntil: s.premiumUntil || 0,
    dailyCount: (s.dailyDate === new Date(now).getFullYear() + '-' + (new Date(now).getMonth() + 1) + '-' + new Date(now).getDate()) ? (s.dailyCount || 0) : 0,
    lang: s.lang === 'en' ? 'en' : 'id',
    banned: !!s.banned,
  })).sort((a, b) => b.downloadBytes - a.downloadBytes);

  const cfg = deps.settings ? deps.settings.getAll() : null;
  let cacheStats = null;
  try { cacheStats = deps.fileCache ? deps.fileCache.stats() : null; } catch (_) { }
  const premiumCount = userList.filter(u => u.tier !== 'free').length;
  const bannedCount = userList.filter(u => u.banned).length;

  let watch = null;
  if (deps.watcher && deps.settings) {
    try {
      const active = deps.watcher.getActiveSources();
      const meta = deps.watcher.getSourcesMeta().filter(m => active.includes(m.key));
      watch = { sources: meta, active, subs: deps.settings.getWatchSubs() };
    } catch (_) { }
  }

  return {
    bot: {
      uptime: Math.floor((Date.now() - botStats.startTime) / 1000),
      totalJobs: botStats.totalJobs,
      downloadedBytes: botStats.downloadedBytes,
      extractedFiles: botStats.extractedFiles,
    },
    queue: {
      maxConcurrency: queueManager.maxConcurrency,
      maxPerUser: queueManager.maxPerUser,
      activeCount: activeJobs.length,
      pendingCount: pendingPerUser.reduce((s, p) => s + p.pending, 0),
      active: activeJobs,
      pendingPerUser,
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
      ramTotal: os.totalmem(),
      ramFree: os.freemem(),
      ramBot: process.memoryUsage().rss,
      systemUptime: Math.floor(os.uptime()),
    },
    users: {
      total: userList.length,
      premiumCount,
      bannedCount,
      list: userList.slice(0, 100),
    },
    cache: cacheStats,
    settings: cfg,
    watch,
    maintenance: deps.settings ? deps.settings.getMaintenance() : false,
  };
}

function renderHtml(state) {
  const ramPct = (((state.system.ramTotal - state.system.ramFree) / state.system.ramTotal) * 100).toFixed(0);
  const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CosTeleBot Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AD%3C/text%3E%3C/svg%3E">
<link rel="apple-touch-icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AD%3C/text%3E%3C/svg%3E">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 20px; }
  h2 { color: #79c0ff; border-bottom: 1px solid #30363d; padding-bottom: 6px; margin-top: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 24px; font-weight: 600; color: #e6edf3; margin-top: 4px; }
  .card .sub { color: #6e7681; font-size: 12px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; font-size: 14px; }
  th { color: #7ee787; font-weight: 600; background: #161b22; }
  tr:hover { background: #161b22; }
  .mono { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; color: #a5d6ff; }
  .bar { background: #21262d; border-radius: 4px; height: 6px; overflow: hidden; margin-top: 4px; }
  .bar-fill { background: linear-gradient(90deg, #238636, #2ea043); height: 100%; }
  .refresh-info { color: #6e7681; font-size: 12px; margin-top: 10px; }
  .empty { color: #6e7681; font-style: italic; padding: 10px; }
  .inp { background:#0d1117; border:1px solid #30363d; color:#e6edf3; border-radius:5px; padding:5px 8px; margin:2px; font-size:13px; }
  button { background:#238636; border:0; color:#fff; border-radius:5px; padding:5px 10px; margin:2px; cursor:pointer; font-size:13px; }
  button:hover { background:#2ea043; }
  h3 { margin-top:18px; }
</style>
</head>
<body>
<h1>🎭 CosTeleBot Dashboard</h1>
${state.maintenance ? '<div style="background:#7d3a00;border:1px solid #da3633;border-radius:6px;padding:10px 14px;margin-bottom:14px;color:#ffd9a0">🛠️ <b>MAINTENANCE MODE AKTIF</b> — user non-admin diblok.</div>' : ''}

<div class="grid">
  <div class="card">
    <div class="label">Bot Uptime</div>
    <div class="value">${fmtUptime(state.bot.uptime)}</div>
    <div class="sub">System: ${fmtUptime(state.system.systemUptime)}</div>
  </div>
  <div class="card">
    <div class="label">RAM Bot</div>
    <div class="value">${fmtBytes(state.system.ramBot)}</div>
    <div class="sub">VPS: ${fmtBytes(state.system.ramTotal - state.system.ramFree)} / ${fmtBytes(state.system.ramTotal)} (${ramPct}%)</div>
    <div class="bar"><div class="bar-fill" style="width: ${ramPct}%"></div></div>
  </div>
  <div class="card">
    <div class="label">Total Downloaded</div>
    <div class="value">${fmtBytes(state.bot.downloadedBytes)}</div>
    <div class="sub">${state.bot.totalJobs} jobs · ${state.bot.extractedFiles} files extracted</div>
  </div>
  <div class="card">
    <div class="label">Queue</div>
    <div class="value">${state.queue.activeCount} / ${state.queue.maxConcurrency}</div>
    <div class="sub">${state.queue.pendingCount} pending · ${state.users.total} total users</div>
  </div>
  <div class="card">
    <div class="label">CPU</div>
    <div class="value">${state.system.cpuCount} cores</div>
    <div class="sub">Load 1m: ${state.system.loadAvg[0].toFixed(2)}</div>
  </div>
</div>

<h2>�️ Control Center</h2>
<div class="grid">
  <div class="card">
    <div class="label">🛠️ Maintenance Mode</div>
    <div style="margin-top:8px">
      <div class="value" style="font-size:18px">${state.maintenance ? '🔴 ON' : '🟢 OFF'}</div>
      <button onclick="maint(${state.maintenance ? 'false' : 'true'})" style="margin-top:6px;background:${state.maintenance ? '#6e7681' : '#da3633'}">${state.maintenance ? 'Turn OFF' : 'Turn ON'}</button>
    </div>
  </div>
  <div class="card">
    <div class="label">⚙️ Queue Concurrency</div>
    <div style="margin-top:8px">
      <input id="q_conc" value="${state.queue.maxConcurrency}" class="inp" style="width:60px">
      <button onclick="setConc()">Set</button>
      <button onclick="clearQ()" style="background:#da3633">Clear Pending (${state.queue.pendingCount})</button>
    </div>
  </div>
  <div class="card">
    <div class="label">🗂️ File-ID Cache</div>
    <div style="margin-top:8px">
      <div class="value" style="font-size:18px">${state.cache ? state.cache.entries : 0} <span class="sub">entries · ${state.cache ? state.cache.totalHits : 0} hits</span></div>
      <button onclick="clearCache()" style="margin-top:6px;background:#da3633">Clear Cache</button>
    </div>
  </div>
  <div class="card">
    <div class="label">🏥 Health & Process</div>
    <div style="margin-top:8px">
      <button onclick="runHealth()">Run Healthcheck</button>
      <button onclick="restart()" style="background:#da3633">Restart Bot</button>
    </div>
    <div id="health_out" class="sub" style="margin-top:8px"></div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="label">📢 Broadcast (HTML ok)</div>
    <div style="margin-top:8px">
      <select id="bc_tier" class="inp">
        <option value="all">Semua user</option>
        <option value="premium">Premium saja</option>
        <option value="vvip">VVIP saja</option>
        <option value="free">Free saja</option>
      </select>
      <textarea id="bc_text" class="inp" style="width:96%;height:60px;display:block;margin-top:6px" placeholder="Pesan broadcast..."></textarea>
      <button onclick="broadcast()" style="margin-top:6px">Kirim Broadcast</button>
    </div>
  </div>
  <div class="card">
    <div class="label">✉️ Direct Message</div>
    <div style="margin-top:8px">
      <input id="dm_uid" placeholder="Chat ID" class="inp">
      <textarea id="dm_text" class="inp" style="width:96%;height:60px;display:block;margin-top:6px" placeholder="Pesan ke user..."></textarea>
      <button onclick="sendDM()" style="margin-top:6px">Kirim DM</button>
    </div>
  </div>
</div>

<h2>�🏃 Active Jobs</h2>
${state.queue.active.length === 0 ? '<div class="empty">No active jobs</div>' : `
<table>
  <thead><tr><th>#</th><th>User</th><th>Title</th><th>Progress</th></tr></thead>
  <tbody>
    ${state.queue.active.map(j => `
      <tr>
        <td class="mono">${j.id}</td>
        <td class="mono">${escape(String(j.chatId))}</td>
        <td>${escape(j.title || '-')}</td>
        <td class="mono">${escape(String(j.progress || '').replace(/<[^>]+>/g, '').slice(0, 120))}</td>
      </tr>
    `).join('')}
  </tbody>
</table>
`}

<h2>📋 Pending Queue (per user)</h2>
${state.queue.pendingPerUser.length === 0 ? '<div class="empty">Queue empty</div>' : `
<table>
  <thead><tr><th>User</th><th>Pending Jobs</th></tr></thead>
  <tbody>
    ${state.queue.pendingPerUser.map(p => `
      <tr>
        <td class="mono">${escape(String(p.chatId))}</td>
        <td>${p.pending}</td>
      </tr>
    `).join('')}
  </tbody>
</table>
`}

<h2>👥 Users (by download size)</h2>
${state.users.list.length === 0 ? '<div class="empty">No users tracked</div>' : `
<table>
  <thead><tr><th>Chat ID</th><th>Tier</th><th>Today</th><th>Gacha</th><th>Downloaded</th><th>Lang</th><th>Action</th></tr></thead>
  <tbody>
    ${state.users.list.map(u => `
      <tr${u.banned ? ' style="opacity:.5"' : ''}>
        <td class="mono">${escape(u.chatId)}${u.banned ? ' 🚫' : ''}</td>
        <td>${u.tier === 'vvip' ? '👑 VVIP' : u.tier === 'premium' ? '💎 Premium' : '🆓 Free'}${u.premiumUntil ? `<div class="sub">${new Date(u.premiumUntil).toISOString().slice(0, 10)}</div>` : ''}</td>
        <td>${u.dailyCount}</td>
        <td>${u.gachaCasts}</td>
        <td>${fmtBytes(u.downloadBytes)}</td>
        <td class="mono">${u.lang}</td>
        <td>
          <button onclick="grant('${escape(u.chatId)}','premium',30)">+P30</button>
          <button onclick="grant('${escape(u.chatId)}','vvip',30)">+V30</button>
          <button onclick="revoke('${escape(u.chatId)}')">✕</button>
          <button onclick="dmUser('${escape(u.chatId)}')" style="background:#1f6feb">✉</button>
          ${u.banned
      ? `<button onclick="ban('${escape(u.chatId)}','unban')" style="background:#6e7681">unban</button>`
      : `<button onclick="ban('${escape(u.chatId)}','ban')" style="background:#da3633">ban</button>`}
        </td>
      </tr>
    `).join('')}
  </tbody>
</table>
`}

<h2>⚙️ Settings</h2>
<div class="grid">
  <div class="card">
    <div class="label">Grant Premium / VVIP</div>
    <div style="margin-top:8px">
      <input id="g_uid" placeholder="Chat ID" class="inp">
      <select id="g_tier" class="inp"><option value="premium">Premium</option><option value="vvip">VVIP</option></select>
      <input id="g_days" placeholder="days" value="30" class="inp" style="width:70px">
      <button onclick="grantForm()">Grant</button>
    </div>
  </div>
  <div class="card">
    <div class="label">Daily Quota Limits</div>
    <div style="margin-top:8px">
      🆓 <input id="lim_free" value="${state.settings ? state.settings.limits.free : ''}" class="inp" style="width:60px">
      💎 <input id="lim_premium" value="${state.settings ? state.settings.limits.premium : ''}" class="inp" style="width:60px">
      👑 <input id="lim_vvip" value="${state.settings ? state.settings.limits.vvip : ''}" class="inp" style="width:60px">
      <button onclick="saveLimits()">Save</button>
    </div>
  </div>
</div>

<h3 style="color:#79c0ff">💰 Plan Prices</h3>
${!state.settings ? '<div class="empty">settings unavailable</div>' : `
<table>
  <thead><tr><th>Tier</th><th>Days</th><th>Price</th><th></th></tr></thead>
  <tbody>
    ${state.settings.plans.map(p => `
      <tr>
        <td>${p.tier === 'vvip' ? '👑 VVIP' : '💎 Premium'}</td>
        <td>${p.days}</td>
        <td><input id="price_${p.tier}_${p.days}" value="${p.price}" class="inp" style="width:80px"></td>
        <td><button onclick="savePrice('${p.tier}',${p.days})">Save</button></td>
      </tr>
    `).join('')}
  </tbody>
</table>
`}

<h3 style="color:#79c0ff">🔔 Watcher Recipients (notif post baru)</h3>
<div class="card">
  <div class="sub">Admin selalu menerima semua source. Di bawah ini penerima tambahan — centang source yang mau dikirim ke tiap orang. (Notif deploy/health terpisah, admin saja.)</div>
  ${!state.watch ? '<div class="empty" style="margin-top:8px">watcher tidak aktif</div>' : `
  <table style="margin-top:8px">
    <thead><tr><th>Chat ID</th>${state.watch.sources.map(s => `<th>${s.icon} ${escape(s.label)}</th>`).join('')}<th></th></tr></thead>
    <tbody>
      ${Object.keys(state.watch.subs).length === 0 ? `<tr><td colspan="${state.watch.sources.length + 2}" class="empty">belum ada penerima tambahan</td></tr>` : Object.entries(state.watch.subs).map(([id, subs]) => {
        const all = subs.includes('all');
        return `<tr>
          <td class="mono">${escape(id)}</td>
          ${state.watch.sources.map(s => `<td style="text-align:center"><input type="checkbox" data-wid="${escape(id)}" data-src="${escape(s.key)}" ${(all || subs.includes(s.key)) ? 'checked' : ''} onchange="watchToggle(this)"></td>`).join('')}
          <td><button onclick="watchDel('${escape(id)}')" style="background:#da3633">✕</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <div style="margin-top:10px">
    <input id="watch_id" placeholder="Chat ID baru" class="inp">
    <button onclick="watchAdd()">+ Tambah Penerima (semua source)</button>
  </div>
  `}
</div>

<h2>📜 Recent Logs</h2>
<div class="card" style="max-height:280px;overflow:auto;font-family:'SF Mono',Consolas,monospace;font-size:12px;line-height:1.6">
  <div id="logbox" class="sub">loading...</div>
</div>

<div id="msg" class="refresh-info"></div>
<div class="refresh-info">Auto-refresh 10s (pauses while typing) · <a href="/admin" style="color: #58a6ff;">manual</a></div>

<script>
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    document.getElementById('msg').textContent = d.ok ? '✅ ' + (d.message || 'OK') : '❌ ' + (d.error || 'failed');
    if (d.ok) setTimeout(() => location.reload(), 700);
    return d;
  }
  function grant(uid, tier, days) { post('/admin/api/grant', { chatId: uid, tier, days }); }
  function revoke(uid) { if (confirm('Revoke premium ' + uid + '?')) post('/admin/api/revoke', { chatId: uid }); }
  function grantForm() { post('/admin/api/grant', { chatId: g_uid.value, tier: g_tier.value, days: parseInt(g_days.value) || 30 }); }
  function saveLimits() { post('/admin/api/limits', { free: lim_free.value, premium: lim_premium.value, vvip: lim_vvip.value }); }
  function savePrice(tier, days) { post('/admin/api/price', { tier, days, price: document.getElementById('price_' + tier + '_' + days).value }); }
  function notifAdd() { post('/admin/api/notify', { add: notif_id.value }); }
  function notifDel(id) { post('/admin/api/notify', { remove: id }); }
  function watchAdd() { if (watch_id.value.trim()) post('/admin/api/watch', { action: 'add', chatId: watch_id.value.trim() }); }
  function watchDel(id) { if (confirm('Hapus penerima ' + id + '?')) post('/admin/api/watch', { action: 'remove', chatId: id }); }
  function watchToggle(el) {
    const id = el.getAttribute('data-wid');
    const boxes = document.querySelectorAll('input[data-wid="' + id + '"]');
    const sources = Array.from(boxes).filter(b => b.checked).map(b => b.getAttribute('data-src'));
    post('/admin/api/watch', { action: 'setsources', chatId: id, sources });
  }
  function ban(uid, action) { if (confirm(action + ' ' + uid + '?')) post('/admin/api/ban', { chatId: uid, action }); }
  function maint(on) { if (confirm((on ? 'Aktifkan' : 'Matikan') + ' maintenance mode?')) post('/admin/api/maintenance', { on }); }
  function setConc() { post('/admin/api/queue', { action: 'concurrency', value: q_conc.value }); }
  function clearQ() { if (confirm('Clear semua antrean pending?')) post('/admin/api/queue', { action: 'clear' }); }
  function clearCache() { if (confirm('Clear file-ID cache?')) post('/admin/api/cache', { action: 'clear' }); }
  function restart() { if (confirm('Restart bot sekarang? Job berjalan akan terputus.')) post('/admin/api/restart', {}); }
  function dmUser(uid) { dm_uid.value = uid; dm_text.focus(); document.getElementById('dm_uid').scrollIntoView({ behavior: 'smooth' }); }
  function sendDM() {
    const t = dm_text.value.trim(); if (!t) return;
    post('/admin/api/dm', { chatId: dm_uid.value, text: t });
  }
  function broadcast() {
    const t = bc_text.value.trim(); if (!t) return;
    if (!confirm('Kirim broadcast ke ' + bc_tier.value + '?')) return;
    post('/admin/api/broadcast', { tier: bc_tier.value, text: t });
  }
  async function runHealth() {
    document.getElementById('health_out').textContent = '⏳ checking...';
    const r = await fetch('/admin/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (d.ok && d.results) {
      document.getElementById('health_out').innerHTML = d.results.map(x =>
        (x.status === 'ok' ? '✅' : x.status === 'warn' ? '⚠️' : '❌') + ' ' + x.name + ' · ' + x.latencyMs + 'ms').join('<br>');
    } else { document.getElementById('health_out').textContent = '❌ ' + (d.error || 'failed'); }
  }
  async function loadLogs() {
    try {
      const r = await fetch('/admin/api/logs');
      const d = await r.json().catch(() => ({}));
      if (d.logs) {
        const col = { info: '#8b949e', ok: '#7ee787', warn: '#e3b341', error: '#f85149' };
        document.getElementById('logbox').innerHTML = d.logs.slice(-120).reverse().map(l =>
          '<span style="color:#6e7681">' + new Date(l.t).toLocaleTimeString() + '</span> ' +
          '<span style="color:' + (col[l.level] || '#c9d1d9') + '">' + l.m.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</span>'
        ).join('<br>');
      }
    } catch (_) { }
  }
  loadLogs(); setInterval(loadLogs, 5000);
  setInterval(() => { if (!/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)) location.reload(); }, 10000);
</script>
</body>
</html>`;
}

function startDashboard(deps) {
  const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const enabled = !!(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS);

  if (!enabled) {
    console.log('\x1b[33m[Dashboard]\x1b[0m disabled (set DASHBOARD_USER + DASHBOARD_PASS env to enable)');
    return null;
  }

  const server = http.createServer((req, res) => {
    // Favicon (sebelum auth) — SVG emoji, supaya tab browser ada ikonnya.
    if (req.url === '/favicon.ico' || req.url === '/favicon.svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎭</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      res.end(svg);
      return;
    }
    if (!checkAuth(req)) return unauthorized(res);

    // ── POST actions (settings) ──
    if (req.method === 'POST' && req.url.startsWith('/admin/api/')) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body || '{}'); } catch (_) { }
        const ok = (message) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, message })); };
        const fail = (error) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error })); };
        try {
          const sdb = deps.statsDb, st = deps.settings;
          const route = req.url.replace('/admin/api/', '');
          if (route === 'grant') {
            if (!sdb || !/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
            const tier = data.tier === 'vvip' ? 'vvip' : 'premium';
            const days = parseInt(data.days, 10) || 30;
            const until = sdb.setPremium(String(data.chatId), days, tier);
            if (deps.onGrant) deps.onGrant(String(data.chatId), tier, days, until);
            return ok(`${tier} ${days}d → ${new Date(until).toISOString().slice(0, 10)}`);
          }
          if (route === 'revoke') {
            if (!sdb || !/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
            sdb.revokePremium(String(data.chatId));
            return ok('revoked');
          }
          if (route === 'limits') {
            if (!st) return fail('settings unavailable');
            ['free', 'premium', 'vvip'].forEach(t => { if (data[t] != null) st.setLimit(t, data[t]); });
            return ok('limits saved');
          }
          if (route === 'price') {
            if (!st) return fail('settings unavailable');
            return st.setPlanPrice(data.tier, parseInt(data.days, 10), parseFloat(data.price)) ? ok('price saved') : fail('plan not found');
          }
          if (route === 'notify') {
            if (!st) return fail('settings unavailable');
            if (data.add && /^\d+$/.test(String(data.add))) st.addNotify(String(data.add));
            if (data.remove) st.removeNotify(String(data.remove));
            return ok('notify updated');
          }
          if (route === 'watch') {
            if (!st) return fail('settings unavailable');
            if (data.action === 'add') {
              if (!/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
              st.addWatchRecipient(String(data.chatId));
              return ok('penerima ditambah');
            }
            if (data.action === 'remove') {
              st.removeWatchRecipient(String(data.chatId));
              return ok('penerima dihapus');
            }
            if (data.action === 'setsources') {
              if (!/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
              st.setWatchSources(String(data.chatId), Array.isArray(data.sources) ? data.sources : []);
              return ok('source diupdate');
            }
            return fail('unknown watch action');
          }
          if (route === 'ban') {
            if (!sdb || !/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
            if (data.action === 'unban') { sdb.unbanUser(String(data.chatId)); return ok('unbanned'); }
            sdb.banUser(String(data.chatId));
            return ok('banned');
          }
          if (route === 'maintenance') {
            if (!st) return fail('settings unavailable');
            const v = st.setMaintenance(!!data.on);
            return ok('maintenance ' + (v ? 'ON' : 'OFF'));
          }
          if (route === 'queue') {
            const qm = deps.queueManager;
            if (!qm) return fail('queue unavailable');
            if (data.action === 'concurrency') return ok('concurrency → ' + qm.setMaxConcurrency(data.value));
            if (data.action === 'clear') return ok(qm.clearAllQueues() + ' pending dibuang');
            return fail('unknown queue action');
          }
          if (route === 'cache') {
            if (!deps.fileCache) return fail('cache unavailable');
            if (data.action === 'clear') return ok(deps.fileCache.clearAll() + ' entries dihapus');
            return fail('unknown cache action');
          }
          if (route === 'dm') {
            if (!deps.onDM || !/^\d+$/.test(String(data.chatId))) return fail('chatId invalid');
            if (!data.text) return fail('text kosong');
            Promise.resolve(deps.onDM(String(data.chatId), String(data.text)))
              .then(() => ok('DM terkirim')).catch(e => fail(e.message));
            return;
          }
          if (route === 'broadcast') {
            if (!deps.onBroadcast) return fail('broadcast unavailable');
            if (!data.text) return fail('text kosong');
            Promise.resolve(deps.onBroadcast(String(data.text), data.tier || 'all'))
              .then(r => ok(`broadcast: ${r.sent}/${r.total} terkirim${r.failed ? `, ${r.failed} gagal` : ''}`))
              .catch(e => fail(e.message));
            return;
          }
          if (route === 'health') {
            if (!deps.healthcheck) return fail('healthcheck unavailable');
            Promise.resolve(deps.healthcheck.checkAllSources())
              .then(results => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, results })); })
              .catch(e => fail(e.message));
            return;
          }
          if (route === 'restart') {
            if (!deps.onRestart) return fail('restart unavailable');
            ok('restarting...');
            deps.onRestart();
            return;
          }
          return fail('unknown action');
        } catch (e) { return fail(e.message); }
      });
      return;
    }

    if (req.url === '/' || req.url === '/admin') {
      try {
        const state = buildStateJson(deps);
        const html = renderHtml(state);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`500: ${e.message}`);
      }
      return;
    }

    if (req.url === '/admin/api/logs') {
      try {
        const logs = deps.getLogs ? deps.getLogs() : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, logs }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.url === '/admin/api' || req.url === '/api') {
      try {
        const state = buildStateJson(deps);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  });

  server.listen(port, host, () => {
    console.log(`\x1b[36m[Dashboard]\x1b[0m listening http://${host}:${port}/admin`);
  });

  server.on('error', (err) => {
    console.log(`\x1b[31m[Dashboard]\x1b[0m error: ${err.message}`);
  });

  return server;
}

module.exports = { startDashboard };
