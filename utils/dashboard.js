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
  :root {
    --bg: #0a0e14; --bg2: #0d1117; --panel: #151b24; --panel2: #1b232e;
    --border: #283241; --border2: #30363d; --text: #d4dde8; --muted: #8593a3;
    --dim: #5c6675; --accent: #58a6ff; --accent2: #7ee787;
    --green: #2ea043; --green2: #238636; --red: #da3633; --red2: #f85149;
    --blue: #1f6feb; --amber: #e3b341; --purple: #a371f7;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: var(--bg); color: var(--text); margin: 0; font-size: 14px; line-height: 1.5; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2a3340; border-radius: 6px; }
  ::-webkit-scrollbar-thumb:hover { background: #3a4654; }
  ::-webkit-scrollbar-track { background: transparent; }
  a { color: var(--accent); text-decoration: none; }

  /* ── Topbar ── */
  .topbar { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 14px;
    padding: 12px 22px; background: rgba(13,17,23,.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; color: #fff; }
  .brand .logo { font-size: 22px; filter: drop-shadow(0 0 8px rgba(88,166,255,.5)); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px;
    font-size: 12px; font-weight: 600; background: rgba(46,160,67,.15); color: var(--accent2); border: 1px solid rgba(46,160,67,.3); }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); box-shadow: 0 0 8px var(--accent2); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
  .pill.warn { background: rgba(218,54,51,.15); color: #ff7b72; border-color: rgba(218,54,51,.4); }
  .pill.warn .dot { background: #ff7b72; box-shadow: 0 0 8px #ff7b72; }
  .topbar .spacer { flex: 1; }
  .topbar .meta { color: var(--muted); font-size: 12px; }
  .switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .switch input { display: none; }
  .switch .track { width: 36px; height: 20px; border-radius: 999px; background: #30363d; position: relative; transition: .2s; }
  .switch .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: .2s; }
  .switch input:checked + .track { background: var(--green); }
  .switch input:checked + .track::after { transform: translateX(16px); }

  /* ── Layout ── */
  .layout { display: flex; align-items: flex-start; }
  .nav { position: sticky; top: 57px; align-self: flex-start; width: 210px; padding: 18px 12px; flex-shrink: 0;
    height: calc(100vh - 57px); overflow-y: auto; }
  .nav a { display: flex; align-items: center; gap: 11px; padding: 10px 14px; border-radius: 9px;
    color: var(--muted); font-weight: 500; margin-bottom: 3px; transition: .15s; }
  .nav a:hover { background: var(--panel); color: var(--text); }
  .nav a.active { background: linear-gradient(90deg, rgba(88,166,255,.18), rgba(88,166,255,.04)); color: #fff;
    box-shadow: inset 3px 0 0 var(--accent); }
  .nav a .ic { font-size: 16px; width: 20px; text-align: center; }
  main { flex: 1; padding: 22px 28px 80px; max-width: 1200px; min-width: 0; }

  h2 { color: #fff; font-size: 19px; margin: 0 0 16px; display: flex; align-items: center; gap: 9px; scroll-margin-top: 72px; }
  h3 { color: var(--accent); font-size: 14px; margin: 22px 0 10px; text-transform: uppercase; letter-spacing: .6px; }
  section { margin-bottom: 38px; }

  /* ── Cards / grid ── */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin: 0 0 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
    transition: .15s; }
  .card:hover { border-color: var(--border2); }
  .stat { position: relative; overflow: hidden; }
  .stat .ic { position: absolute; top: 12px; right: 14px; font-size: 26px; opacity: .25; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .7px; font-weight: 600; }
  .card .value { font-size: 26px; font-weight: 700; color: #fff; margin-top: 6px; letter-spacing: -.5px; }
  .card .sub { color: var(--dim); font-size: 12px; margin-top: 5px; }

  /* ── Tables ── */
  .tablewrap { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; background: var(--panel2); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: .1s; }
  tbody tr:hover { background: rgba(88,166,255,.05); }
  .mono { font-family: 'SF Mono', ui-monospace, Consolas, monospace; font-size: 12px; color: #9ecbff; }

  .bar { background: #21262d; border-radius: 999px; height: 6px; overflow: hidden; margin-top: 8px; }
  .bar-fill { background: linear-gradient(90deg, #2ea043, #56d364); height: 100%; border-radius: 999px; transition: width .4s; }
  .empty { color: var(--dim); font-style: italic; padding: 16px; text-align: center; }

  /* ── Inputs / buttons ── */
  .inp { background: var(--bg2); border: 1px solid var(--border2); color: var(--text); border-radius: 8px;
    padding: 8px 11px; margin: 2px; font-size: 13px; outline: none; transition: .15s; }
  .inp:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,.15); }
  textarea.inp { resize: vertical; font-family: inherit; }
  button { background: var(--green2); border: 0; color: #fff; border-radius: 8px; padding: 8px 14px; margin: 2px;
    cursor: pointer; font-size: 13px; font-weight: 600; transition: .15s; }
  button:hover { background: var(--green); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button.danger, button[style*="da3633"] { background: var(--red) !important; }
  button.danger:hover { background: var(--red2) !important; }
  button.blue { background: var(--blue); }
  button.ghost { background: #2a3340; }
  button.ghost:hover { background: #3a4654; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.vvip { background: rgba(163,113,247,.18); color: #d2a8ff; }
  .badge.premium { background: rgba(88,166,255,.18); color: #9ecbff; }
  .badge.free { background: #2a3340; color: var(--muted); }
  .fieldrow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 10px; }

  /* ── Toast ── */
  #toast { position: fixed; bottom: 24px; right: 24px; z-index: 100; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: var(--panel2); border: 1px solid var(--border2); border-left: 4px solid var(--accent);
    border-radius: 9px; padding: 12px 18px; color: var(--text); font-size: 13px; min-width: 220px; max-width: 360px;
    box-shadow: 0 8px 28px rgba(0,0,0,.5); animation: slidein .25s ease; }
  .toast.ok { border-left-color: var(--green); }
  .toast.err { border-left-color: var(--red2); }
  @keyframes slidein { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .logbox { background: var(--bg2); border-radius: 10px; padding: 14px; max-height: 420px; overflow: auto;
    font-family: 'SF Mono', ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.7; }
  .maint-banner { background: linear-gradient(90deg, rgba(218,54,51,.2), rgba(218,54,51,.05));
    border: 1px solid rgba(218,54,51,.4); border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; color: #ffd9a0; }

  @media (max-width: 760px) {
    .nav { position: static; width: 100%; height: auto; display: flex; gap: 6px; overflow-x: auto; padding: 10px;
      border-bottom: 1px solid var(--border); }
    .nav a { white-space: nowrap; padding: 8px 12px; margin: 0; }
    .nav a.active { box-shadow: inset 0 -3px 0 var(--accent); }
    .layout { flex-direction: column; }
    main { padding: 16px; }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="logo">🎭</span> CosTeleBot</div>
  <span class="pill ${state.maintenance ? 'warn' : ''}"><span class="dot"></span>${state.maintenance ? 'Maintenance' : 'Online'}</span>
  <span class="meta">⏳ ${fmtUptime(state.bot.uptime)}</span>
  <div class="spacer"></div>
  <span class="meta" id="clock"></span>
  <label class="switch"><input type="checkbox" id="autoref" checked><span class="track"></span> Auto-refresh</label>
</div>

<div class="layout">
  <aside class="nav">
    <a href="#overview" class="navlink"><span class="ic">📊</span> Overview</a>
    <a href="#control" class="navlink"><span class="ic">🎛️</span> Control</a>
    <a href="#jobs" class="navlink"><span class="ic">🏃</span> Queue</a>
    <a href="#users" class="navlink"><span class="ic">👥</span> Users</a>
    <a href="#settings" class="navlink"><span class="ic">⚙️</span> Settings</a>
    <a href="#logs" class="navlink"><span class="ic">📜</span> Logs</a>
  </aside>
  <main>

${state.maintenance ? '<div class="maint-banner">🛠️ <b>MAINTENANCE MODE AKTIF</b> — semua user non-admin sedang diblok.</div>' : ''}

<section id="overview">
<h2>📊 Overview</h2>
<div class="grid">
  <div class="card stat">
    <span class="ic">⏱️</span>
    <div class="label">Bot Uptime</div>
    <div class="value">${fmtUptime(state.bot.uptime)}</div>
    <div class="sub">System: ${fmtUptime(state.system.systemUptime)}</div>
  </div>
  <div class="card stat">
    <span class="ic">🧠</span>
    <div class="label">RAM Bot</div>
    <div class="value">${fmtBytes(state.system.ramBot)}</div>
    <div class="sub">VPS: ${fmtBytes(state.system.ramTotal - state.system.ramFree)} / ${fmtBytes(state.system.ramTotal)} (${ramPct}%)</div>
    <div class="bar"><div class="bar-fill" style="width: ${ramPct}%"></div></div>
  </div>
  <div class="card stat">
    <span class="ic">📥</span>
    <div class="label">Total Downloaded</div>
    <div class="value">${fmtBytes(state.bot.downloadedBytes)}</div>
    <div class="sub">${state.bot.totalJobs} jobs · ${state.bot.extractedFiles} files</div>
  </div>
  <div class="card stat">
    <span class="ic">🚦</span>
    <div class="label">Queue</div>
    <div class="value">${state.queue.activeCount} / ${state.queue.maxConcurrency}</div>
    <div class="sub">${state.queue.pendingCount} pending</div>
  </div>
  <div class="card stat">
    <span class="ic">👥</span>
    <div class="label">Users</div>
    <div class="value">${state.users.total}</div>
    <div class="sub">💎 ${state.users.premiumCount} premium · 🚫 ${state.users.bannedCount} banned</div>
  </div>
  <div class="card stat">
    <span class="ic">⚡</span>
    <div class="label">CPU</div>
    <div class="value">${state.system.cpuCount} cores</div>
    <div class="sub">Load 1m: ${state.system.loadAvg[0].toFixed(2)}</div>
  </div>
</div>
</section>

<section id="control">
<h2>🎛️ Control Center</h2>
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

</section>
<section id="jobs">
<h2>🏃 Active Jobs</h2>
${state.queue.active.length === 0 ? '<div class="empty">No active jobs</div>' : `
<div class="tablewrap"><table>
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
</table></div>
`}

<h2>📋 Pending Queue (per user)</h2>
${state.queue.pendingPerUser.length === 0 ? '<div class="empty">Queue empty</div>' : `
<div class="tablewrap"><table>
  <thead><tr><th>User</th><th>Pending Jobs</th></tr></thead>
  <tbody>
    ${state.queue.pendingPerUser.map(p => `
      <tr>
        <td class="mono">${escape(String(p.chatId))}</td>
        <td>${p.pending}</td>
      </tr>
    `).join('')}
  </tbody>
</table></div>
`}

</section>
<section id="users">
<h2>👥 Users <span class="sub" style="font-weight:400">(by download size)</span></h2>
<div class="fieldrow" style="margin-bottom:12px"><input id="user_search" class="inp" placeholder="🔍 Cari chat ID / tier..." style="width:280px" oninput="userFilter()"></div>
${state.users.list.length === 0 ? '<div class="empty">No users tracked</div>' : `
<div class="tablewrap"><table>
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
</table></div>
`}

</section>
<section id="settings">
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
<div class="tablewrap"><table>
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
</table></div>
`}

<h3 style="color:#79c0ff">🔔 Watcher Recipients (notif post baru)</h3>
<div class="card">
  <div class="sub">Admin selalu menerima semua source. Di bawah ini penerima tambahan — centang source yang mau dikirim ke tiap orang. (Notif deploy/health terpisah, admin saja.)</div>
  ${!state.watch ? '<div class="empty" style="margin-top:8px">watcher tidak aktif</div>' : `
  <div class="tablewrap"><table style="margin-top:8px">
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
  </table></div>
  <div style="margin-top:10px">
    <input id="watch_id" placeholder="Chat ID baru" class="inp">
    <button onclick="watchAdd()">+ Tambah Penerima (semua source)</button>
  </div>
  `}
</div>

</section>
<section id="logs">
<h2>📜 Recent Logs</h2>
<div style="margin-bottom:10px">
  <button class="ghost" onclick="logFilter('all',this)">All</button>
  <button class="ghost" onclick="logFilter('info',this)">Info</button>
  <button class="ghost" onclick="logFilter('ok',this)">OK</button>
  <button class="ghost" onclick="logFilter('warn',this)">Warn</button>
  <button class="ghost" onclick="logFilter('error',this)">Error</button>
</div>
<div class="logbox" id="logbox">loading...</div>
</section>

  </main>
</div>
<div id="toast"></div>

<script>
  // ── Toast feedback ──
  function toast(msg, type) {
    const box = document.getElementById('toast');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
  }
  // Simpan posisi scroll supaya reload tidak melompat ke atas.
  window.addEventListener('beforeunload', () => sessionStorage.setItem('sy', window.scrollY));
  window.addEventListener('DOMContentLoaded', () => {
    const sy = sessionStorage.getItem('sy'); if (sy) window.scrollTo(0, parseInt(sy));
  });

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    toast((d.ok ? '✅ ' : '❌ ') + (d.ok ? (d.message || 'OK') : (d.error || 'failed')), d.ok ? 'ok' : 'err');
    if (d.ok) setTimeout(() => location.reload(), 800);
    return d;
  }
  function grant(uid, tier, days) { post('/admin/api/grant', { chatId: uid, tier, days }); }
  function revoke(uid) { if (confirm('Revoke premium ' + uid + '?')) post('/admin/api/revoke', { chatId: uid }); }
  function grantForm() { post('/admin/api/grant', { chatId: g_uid.value, tier: g_tier.value, days: parseInt(g_days.value) || 30 }); }
  function saveLimits() { post('/admin/api/limits', { free: lim_free.value, premium: lim_premium.value, vvip: lim_vvip.value }); }
  function savePrice(tier, days) { post('/admin/api/price', { tier, days, price: document.getElementById('price_' + tier + '_' + days).value }); }
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
  function dmUser(uid) { dm_uid.value = uid; document.querySelector('a[href="#control"]').click(); setTimeout(() => dm_text.focus(), 300); }
  function sendDM() {
    const t = dm_text.value.trim(); if (!t) return toast('Pesan kosong', 'err');
    post('/admin/api/dm', { chatId: dm_uid.value, text: t });
  }
  function broadcast() {
    const t = bc_text.value.trim(); if (!t) return toast('Pesan kosong', 'err');
    if (!confirm('Kirim broadcast ke ' + bc_tier.value + '?')) return;
    post('/admin/api/broadcast', { tier: bc_tier.value, text: t });
  }
  // ── Users live filter ──
  function userFilter() {
    const q = (document.getElementById('user_search').value || '').toLowerCase();
    document.querySelectorAll('#users tbody tr').forEach(tr => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
  async function runHealth() {
    document.getElementById('health_out').innerHTML = '⏳ checking...';
    const r = await fetch('/admin/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (d.ok && d.results) {
      document.getElementById('health_out').innerHTML = d.results.map(x =>
        (x.status === 'ok' ? '✅' : x.status === 'warn' ? '⚠️' : '❌') + ' ' + x.name + ' · ' + x.latencyMs + 'ms').join('<br>');
    } else { document.getElementById('health_out').textContent = '❌ ' + (d.error || 'failed'); }
  }
  // ── Logs ──
  let logLevel = 'all';
  function logFilter(lv, btn) { logLevel = lv; document.querySelectorAll('#logs .ghost').forEach(b => b.style.background = ''); if (btn) btn.style.background = '#1f6feb'; renderLogs(); }
  let lastLogs = [];
  function renderLogs() {
    const col = { info: '#8593a3', ok: '#7ee787', warn: '#e3b341', error: '#f85149' };
    const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const filtered = lastLogs.filter(l => logLevel === 'all' || l.level === logLevel);
    document.getElementById('logbox').innerHTML = filtered.slice(-150).reverse().map(l =>
      '<span style="color:#5c6675">' + new Date(l.t).toLocaleTimeString() + '</span> ' +
      '<span style="color:' + (col[l.level] || '#d4dde8') + '">[' + l.level + '] ' + esc(l.m) + '</span>'
    ).join('<br>') || '<span class="sub">no logs</span>';
  }
  async function loadLogs() {
    try {
      const r = await fetch('/admin/api/logs');
      const d = await r.json().catch(() => ({}));
      if (d.logs) { lastLogs = d.logs; renderLogs(); }
    } catch (_) { }
  }
  // ── Nav active highlight on scroll ──
  const links = [...document.querySelectorAll('.navlink')];
  const secs = links.map(a => document.querySelector(a.getAttribute('href')));
  function onScroll() {
    let idx = 0;
    secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top <= 120) idx = i; });
    links.forEach((a, i) => a.classList.toggle('active', i === idx));
  }
  window.addEventListener('scroll', onScroll); onScroll();
  // ── Clock + auto-refresh toggle ──
  function tick() { document.getElementById('clock').textContent = new Date().toLocaleTimeString(); }
  tick(); setInterval(tick, 1000);
  loadLogs(); setInterval(loadLogs, 5000);
  setInterval(() => {
    const ar = document.getElementById('autoref');
    if (ar && ar.checked && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)) location.reload();
  }, 10000);
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
