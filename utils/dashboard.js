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
  })).sort((a, b) => b.downloadBytes - a.downloadBytes);

  const cfg = deps.settings ? deps.settings.getAll() : null;

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
      list: userList.slice(0, 50),
    },
    settings: cfg,
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

<h2>🏃 Active Jobs</h2>
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
      <tr>
        <td class="mono">${escape(u.chatId)}</td>
        <td>${u.tier === 'vvip' ? '👑 VVIP' : u.tier === 'premium' ? '💎 Premium' : '🆓 Free'}${u.premiumUntil ? `<div class="sub">${new Date(u.premiumUntil).toISOString().slice(0, 10)}</div>` : ''}</td>
        <td>${u.dailyCount}</td>
        <td>${u.gachaCasts}</td>
        <td>${fmtBytes(u.downloadBytes)}</td>
        <td class="mono">${u.lang}</td>
        <td>
          <button onclick="grant('${escape(u.chatId)}','premium',30)">+P30</button>
          <button onclick="grant('${escape(u.chatId)}','vvip',30)">+V30</button>
          <button onclick="revoke('${escape(u.chatId)}')">✕</button>
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

<h3 style="color:#79c0ff">🔔 Extra Notify Recipients</h3>
<div class="card">
  <div class="sub">Chat ID tambahan yang dapat notif deploy/health (selain admin).</div>
  <div style="margin-top:8px">
    ${(state.settings && state.settings.notifyExtra.length) ? state.settings.notifyExtra.map(id => `<span class="mono">${escape(id)}</span> <button onclick="notifDel('${escape(id)}')">✕</button> &nbsp;`).join('') : '<span class="empty">none</span>'}
  </div>
  <div style="margin-top:8px">
    <input id="notif_id" placeholder="Chat ID" class="inp">
    <button onclick="notifAdd()">Add</button>
  </div>
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
  setInterval(() => { if (!/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) location.reload(); }, 10000);
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
