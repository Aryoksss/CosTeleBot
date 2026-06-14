'use strict';

/**
 * Browser Reaper — jaring pengaman untuk proses Chromium (Playwright) yang nyangkut.
 *
 * Semua scraper sudah menutup browser di blok finally, tapi kalau proses crash di
 * tengah jalan, Chromium bisa jadi zombie dan makan RAM. Reaper ini secara berkala
 * mematikan proses chrome/chromium headless yang umurnya melebihi ambang (default 5
 * menit) — jauh lebih lama dari operasi resolve/scrape normal (detik-an), jadi aman.
 *
 * Linux-only (pakai ps/awk). Di OS lain → no-op.
 *
 * Env:
 *   BROWSER_REAP_MINUTES   umur maksimum proses sebelum dibunuh (default 5)
 *   BROWSER_REAP_INTERVAL  jeda antar sapuan, menit (default 5)
 */

const { exec } = require('child_process');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
};

/**
 * Cari & bunuh proses browser headless yang lebih tua dari maxMinutes.
 */
function reapStaleBrowsers(maxMinutes) {
  if (process.platform !== 'linux') return;
  const maxSec = Math.max(60, maxMinutes * 60);

  // etimes = umur proses (detik). Cocokkan baris yang mengandung chrome/chromium/
  // headless_shell DAN lebih tua dari ambang. Membunuh proses induk akan ikut
  // mematikan child renderer-nya.
  const cmd = `ps -eo pid=,etimes=,args= | awk -v max=${maxSec} 'tolower($0) ~ /chrome|chromium|headless_shell/ && ($2+0) > max { print $1 }'`;

  exec(cmd, { timeout: 10000 }, (err, stdout) => {
    if (err) return; // ps/awk tak tersedia / gagal → diam saja
    const pids = String(stdout).split('\n').map(s => s.trim()).filter(Boolean);
    if (!pids.length) return;

    let killed = 0;
    for (const pid of pids) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n === process.pid) continue;
      try { process.kill(n, 'SIGKILL'); killed++; } catch (_) { /* sudah mati / bukan milik kita */ }
    }
    if (killed) log.warn(`[BrowserReaper] membunuh ${killed} proses browser stale (>${maxMinutes}m): ${pids.join(', ')}`);
  });
}

/**
 * Mulai reaper berkala. Return timer (atau null kalau bukan Linux).
 */
function startBrowserReaper(opts = {}) {
  if (process.platform !== 'linux') {
    log.info('[BrowserReaper] dilewati (bukan Linux).');
    return null;
  }
  const maxMinutes = parseInt(process.env.BROWSER_REAP_MINUTES || String(opts.maxMinutes || 5), 10);
  const intervalMinutes = parseInt(process.env.BROWSER_REAP_INTERVAL || String(opts.intervalMinutes || 5), 10);

  const timer = setInterval(() => reapStaleBrowsers(maxMinutes), intervalMinutes * 60 * 1000);
  if (timer.unref) timer.unref(); // jangan tahan event loop
  log.info(`[BrowserReaper] aktif: bersihkan browser >${maxMinutes}m setiap ${intervalMinutes}m`);
  return timer;
}

module.exports = { startBrowserReaper, reapStaleBrowsers };
