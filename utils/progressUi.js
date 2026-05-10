/**
 * Unified progress bar renderer untuk semua operasi download/upload/compress di bot.
 *
 * Sebelumnya tiap scraper (Gofile, Javtiful, EroThots, Pinterest, R34, Sharp compress)
 * punya format progress bar + throttling yang beda-beda. Helper ini memberikan
 * satu rendering konsisten:
 *   ⬇️ <b>Title</b>
 *   ████████░░░░░░░░░░░░ 42.3%
 *   123.4 / 473.1 MB · 8.2 MB/s · ETA 2m 15s
 *
 * API:
 *   renderProgressBar({ icon, title, done, total, unit?, showSpeed?, startedAt? })
 *     → HTML string siap dikirim ke Telegram (parse_mode='HTML')
 *
 *   createProgressThrottler(minInterval=2500)
 *     → function yang ngatur throttle + force tick final otomatis
 */

const BAR_WIDTH = 20;
const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

function fmtUnit(bytes) {
  if (bytes == null || isNaN(bytes)) return '?';
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return '~';
  if (sec < 1) return '<1s';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}

function fmtCount(done, total, unit) {
  const d = total ? done : done;
  const t = total;
  if (unit === 'bytes') {
    return `${fmtUnit(d)} / ${fmtUnit(t)}`;
  }
  // Default: count unit (files, items)
  return `${d} / ${t || '?'}`;
}

function makeBar(pct) {
  if (isNaN(pct) || pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  const filled = Math.round((pct / BAR_WIDTH) * BAR_WIDTH / 100 * BAR_WIDTH / BAR_WIDTH);
  // Simplified: (pct/100) * width, rounded
  const f = Math.round((pct / 100) * BAR_WIDTH);
  return BLOCK_FULL.repeat(f) + BLOCK_EMPTY.repeat(BAR_WIDTH - f);
}

/**
 * Render progress bar lengkap sebagai HTML string.
 *
 * @param {object} opts
 * @param {string} [opts.icon='⬇️']      Emoji icon (⬇️/📤/🗜️/🎰 dll)
 * @param {string} [opts.title='']       Judul item (bisa multi-word, akan ditrim)
 * @param {number} opts.done             Progress sekarang (byte atau count)
 * @param {number} [opts.total]          Total target. null/0 berarti unknown.
 * @param {'bytes'|'items'} [opts.unit='bytes']  Format unit
 * @param {boolean} [opts.showSpeed=true]
 * @param {boolean} [opts.showEta=true]
 * @param {number} [opts.startedAt=Date.now()]  Timestamp mulai (untuk hitung speed/eta)
 * @param {string} [opts.subtitle]       Baris info tambahan (optional)
 * @returns {string} HTML string
 */
function renderProgressBar(opts = {}) {
  const {
    icon = '⬇️',
    title = '',
    done = 0,
    total = null,
    unit = 'bytes',
    showSpeed = true,
    showEta = true,
    startedAt = Date.now(),
    subtitle = null,
  } = opts;

  const pct = total > 0 ? (done / total) * 100 : null;
  const bar = pct !== null ? `<code>${makeBar(pct)} ${pct.toFixed(1)}%</code>` : `<code>${BLOCK_EMPTY.repeat(BAR_WIDTH)} ...</code>`;

  // Build info line: <count> · <speed> · <eta>
  const info = [];
  info.push(fmtCount(done, total, unit));

  if (showSpeed && unit === 'bytes') {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed > 0.1) {
      const mbps = (done / 1048576) / elapsed;
      if (mbps >= 0.1) info.push(`${mbps.toFixed(1)} MB/s`);
    }
  }

  if (showEta && total > 0) {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed > 0.5 && done > 0) {
      const rate = done / elapsed;
      const remaining = (total - done) / rate;
      info.push(`ETA ${fmtEta(remaining)}`);
    }
  }

  const lines = [];
  // Header dengan icon + title (truncate panjang)
  const headerTitle = title ? title.slice(0, 80) : '';
  if (headerTitle) lines.push(`${icon} <b>${headerTitle}</b>`);
  else lines.push(`${icon} <b>Processing...</b>`);

  if (subtitle) lines.push(`<i>${subtitle.slice(0, 100)}</i>`);
  lines.push(bar);
  lines.push(`<code>${info.join(' · ')}</code>`);

  return lines.join('\n');
}

/**
 * Create a throttler function untuk rate-limit updateProgress() calls ke Telegram.
 * Prevents ETELEGRAM 429 dari terlalu banyak editMessageText call.
 *
 * Usage:
 *   const update = createProgressThrottler(2500);
 *   downloadStream(url, dest, (pct, dl, tot) => {
 *     update(() => sendStatus(renderProgressBar({ done: dl, total: tot, ... })));
 *   });
 *
 * Force tick final (misal saat complete): panggil dengan forceNow=true.
 *
 * @param {number} minInterval  Minimum ms between updates (default 2500)
 * @returns {function} throttled(fn, forceNow=false)
 */
function createProgressThrottler(minInterval = 2500) {
  let lastCall = 0;
  return function throttled(fn, forceNow = false) {
    const now = Date.now();
    if (!forceNow && now - lastCall < minInterval) return;
    lastCall = now;
    try {
      fn();
    } catch (_) { /* swallow */ }
  };
}

module.exports = {
  renderProgressBar,
  createProgressThrottler,
  // Helpers exposed untuk testing
  makeBar,
  fmtUnit,
  fmtEta,
};
