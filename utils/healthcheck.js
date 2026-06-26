/**
 * Healthcheck utility: ping semua source + infra + return status + latency.
 *
 * Design: tiap check punya timeout ketat (max 8s) agar total healthcheck < 30s.
 * Paralel Promise.allSettled — satu source timeout tidak block yang lain.
 *
 * Return struktur:
 *   [
 *     { name, status: 'ok'|'warn'|'error', latencyMs, note },
 *     ...
 *   ]
 */

const axios = require('axios');
const os = require('os');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120';
const TIMEOUT = 8000;

const client = axios.create({
  headers: { 'User-Agent': UA },
  timeout: TIMEOUT,
  validateStatus: () => true,
});

/**
 * Check satu URL: return { status, latencyMs, note }.
 * Status heuristic:
 *   2xx → 'ok'
 *   403/429 → 'warn' (blocked / rate-limit, still reachable)
 *   4xx/5xx lainnya → 'error'
 *   timeout / network error → 'error'
 */
async function checkUrl(name, url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await client.get(url, opts);
    const latencyMs = Date.now() - t0;
    const status = r.status;
    if (status >= 200 && status < 300) {
      return { name, status: 'ok', latencyMs, note: `HTTP ${status}` };
    }
    if (status === 403 || status === 429) {
      return { name, status: 'warn', latencyMs, note: `HTTP ${status} (possibly rate-limited)` };
    }
    return { name, status: 'error', latencyMs, note: `HTTP ${status}` };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const code = e.code || 'ERR';
    return { name, status: 'error', latencyMs, note: code };
  }
}

/**
 * Check Kemono khusus: situs pakai DDoS-Guard + API butuh header `Accept: text/css`.
 * GET homepage polos sering kena 403/challenge → false negative. Coba beberapa mirror
 * pakai endpoint API ringan; ok kalau ADA mirror yang reachable.
 */
async function checkKemono() {
  const hosts = ['kemono.cr', 'kemono.su'];
  // Endpoint yang sama persis dipakai bot (kreator yang pasti ada) → sinyal akurat.
  const probePath = '/api/v1/patreon/user/3295915/profile';
  const t0 = Date.now();
  let lastNote = 'unreachable';
  for (const h of hosts) {
    try {
      const r = await axios.get(`https://${h}${probePath}`, {
        headers: { 'accept': 'text/css', 'user-agent': UA, 'referer': `https://${h}/` },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        return { name: 'Kemono', status: 'ok', latencyMs: Date.now() - t0, note: h };
      }
      lastNote = `${h} HTTP ${r.status}`;
    } catch (e) {
      lastNote = `${h} ${e.code || 'ERR'}`;
    }
  }
  // Semua mirror tak balas 2xx → warn (DDoS-Guard sementara), bukan error mati total.
  return { name: 'Kemono', status: 'warn', latencyMs: Date.now() - t0, note: lastNote };
}

/**
 * Check source-source scraper.
 */
async function checkAllSources() {
  const checks = [
    checkUrl('Cosplaytele', 'https://cosplaytele.com/'),
    checkUrl('Javtiful', 'https://javtiful.com/'),
    checkUrl('EroThots', 'https://erothots.co/'),
    checkUrl('XNXX', 'https://www.xnxx.com/'),
    checkUrl('Rule34Video', 'https://rule34video.com/'),
    checkUrl('Pinterest API', 'https://www.pinterest.com/'),
    checkKemono(),
    checkUrl('Gofile API', 'https://api.gofile.io/servers'),
    checkUrl('Telegram API', 'https://api.telegram.org/'),
  ];

  // Groq LLM (optional, only if key set)
  if (process.env.GROQ_API_KEY) {
    checks.push((async () => {
      const t0 = Date.now();
      try {
        const r = await axios.get('https://api.groq.com/openai/v1/models', {
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          timeout: TIMEOUT,
          validateStatus: () => true,
        });
        const latencyMs = Date.now() - t0;
        if (r.status === 200) return { name: 'Groq LLM', status: 'ok', latencyMs, note: `${(r.data.data || []).length} models` };
        if (r.status === 401) return { name: 'Groq LLM', status: 'error', latencyMs, note: 'Invalid key' };
        if (r.status === 429) return { name: 'Groq LLM', status: 'warn', latencyMs, note: 'Rate-limited' };
        return { name: 'Groq LLM', status: 'error', latencyMs, note: `HTTP ${r.status}` };
      } catch (e) {
        return { name: 'Groq LLM', status: 'error', latencyMs: Date.now() - t0, note: e.code || 'ERR' };
      }
    })());
  }

  // Local Telegram Bot API Server check
  if (process.env.LOCAL_API_URL) {
    checks.push(checkUrl('Local Bot API', process.env.LOCAL_API_URL + '/bot' + (process.env.BOT_TOKEN || 'x') + '/getMe'));
  }

  const results = await Promise.allSettled(checks);
  return results.map(r => r.status === 'fulfilled' ? r.value : ({ name: 'unknown', status: 'error', latencyMs: 0, note: r.reason?.message || 'rejected' }));
}

/**
 * System info: uptime, memory, CPU, free disk (approx).
 */
function getSystemInfo(botStartTime) {
  const uptimeBot = Math.floor((Date.now() - botStartTime) / 1000);
  const uptimeSys = Math.floor(os.uptime());
  const ramTotal = os.totalmem() / 1048576;
  const ramFree = os.freemem() / 1048576;
  const ramUsed = (process.memoryUsage().rss) / 1048576;
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg();

  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `${d}d ${h % 24}h ${m}m`;
    }
    return `${h}h ${m}m`;
  };

  return {
    botUptime: fmt(uptimeBot),
    systemUptime: fmt(uptimeSys),
    ramBotMB: ramUsed.toFixed(1),
    ramTotalMB: ramTotal.toFixed(0),
    ramFreeMB: ramFree.toFixed(0),
    ramUsedPct: (((ramTotal - ramFree) / ramTotal) * 100).toFixed(0),
    cpuCount,
    loadAvg1m: loadAvg[0].toFixed(2),
  };
}

/**
 * Format results sebagai HTML untuk Telegram.
 */
function formatHealthReport(results, sysInfo) {
  const statusIcon = { ok: '✅', warn: '⚠️', error: '❌' };
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const errCount = results.filter(r => r.status === 'error').length;

  const overall = errCount > 0 ? '❌ Issues detected'
    : warnCount > 0 ? '⚠️ Minor warnings'
      : '✅ All systems operational';

  let text = `🏥 <b>Health Check</b>\n${overall}\n\n`;

  // Group by status (error > warn > ok)
  const sorted = [...results].sort((a, b) => {
    const rank = { error: 0, warn: 1, ok: 2 };
    return rank[a.status] - rank[b.status];
  });

  text += `<b>Sources + Infra (${okCount}/${results.length} healthy):</b>\n`;
  for (const r of sorted) {
    const icon = statusIcon[r.status] || '?';
    const lat = r.latencyMs != null ? `${r.latencyMs}ms` : '-';
    text += `${icon} <b>${r.name}</b> · ${lat}`;
    if (r.note && r.note !== 'HTTP 200') text += ` <i>(${r.note})</i>`;
    text += '\n';
  }

  if (sysInfo) {
    text += `\n<b>System:</b>\n`;
    text += `⏳ Bot uptime: ${sysInfo.botUptime}\n`;
    text += `🖥️ RAM bot: ${sysInfo.ramBotMB} MB / VPS ${sysInfo.ramTotalMB} MB (${sysInfo.ramUsedPct}%)\n`;
    text += `⚡ CPU: ${sysInfo.cpuCount} cores · load 1m ${sysInfo.loadAvg1m}\n`;
  }

  return text;
}

module.exports = {
  checkAllSources,
  checkUrl,
  getSystemInfo,
  formatHealthReport,
};
