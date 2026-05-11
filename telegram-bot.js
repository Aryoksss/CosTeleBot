'use strict';
require('dotenv').config(); // Load environment variables dari file .env

// --- QUEUE MANAGER ---
// Round-robin queue fairness: pisah antrean per-user, pick job dari user yang paling
// lama tidak kebagian giliran. Mencegah 1 user dengan 3 job besar monopoli bot.
//
// Data structure:
//   this.userQueues: Map<chatId, Job[]>       — FIFO per user
//   this.userLastServed: Map<chatId, number>  — timestamp terakhir user kebagian slot
//   this.activeJobs: Map<jobId, activeEntry>  — yang lagi running
//
// Algorithm checkQueue:
//   1. Pick user dengan antrean non-empty + userLastServed paling lama (atau never)
//   2. Shift job pertama dari user itu, jalankan
//
// Fairness property: 2 user sama-sama masukkan 3 job → execution order A,B,A,B,A,B
// bukan A,A,A,B,B,B (FIFO lama).
class DownloadQueue {
  constructor() {
    this.userQueues = new Map();      // chatId -> Job[]
    this.userLastServed = new Map();  // chatId -> timestamp
    this.activeJobs = new Map();      // id -> activeEntry
    this.jobCounter = 1;
    // Configurable via env untuk tuning per-VPS-spec.
    // Default: 6 concurrent + 8 per-user (cocok untuk VPS 2 vCPU + 4 GB RAM).
    // Tuning guide:
    //   1 GB RAM:  QUEUE_CONCURRENCY=2-3
    //   2 GB RAM:  QUEUE_CONCURRENCY=4-5
    //   4 GB RAM:  QUEUE_CONCURRENCY=6-8  (default)
    //   8 GB RAM:  QUEUE_CONCURRENCY=10-12
    // Per job peak RAM ~250 MB (download + extract + sharp compress 4K + upload).
    // Bottleneck nyata biasanya bandwidth + Telegram upload rate, bukan CPU.
    this.maxConcurrency = parseInt(process.env.QUEUE_CONCURRENCY || '6', 10);
    this.maxPerUser = parseInt(process.env.QUEUE_MAX_PER_USER || '8', 10);
    // Pakai console.log langsung (bukan log.info) karena `log` belum didefinisikan saat constructor jalan.
    console.log(`\x1b[36m[Queue]\x1b[0m config: maxConcurrency=${this.maxConcurrency} maxPerUser=${this.maxPerUser}`);
  }

  /**
   * Total pending untuk 1 user (queue + active).
   */
  userLoad(chatId) {
    const qLen = (this.userQueues.get(chatId) || []).length;
    const activeLen = Array.from(this.activeJobs.values()).filter(j => j.chatId === chatId).length;
    return qLen + activeLen;
  }

  /**
   * Total pending global (queue + active, semua user).
   */
  totalPending() {
    let total = this.activeJobs.size;
    for (const q of this.userQueues.values()) total += q.length;
    return total;
  }

  /**
   * Queue length per user (untuk /tasks command).
   */
  snapshotQueues() {
    const arr = [];
    for (const [chatId, q] of this.userQueues.entries()) {
      if (q.length > 0) arr.push({ chatId, pending: q.length });
    }
    return arr;
  }

  addJob(chatId, title, execFunc, bot) {
    if (this.userLoad(chatId) >= this.maxPerUser) {
      bot.sendMessage(chatId,
        `⛔ <b>Antrean Penuh!</b> Anda hanya diizinkan menitipkan maksimal ${this.maxPerUser} tugas unduhan (termasuk yang sedang berjalan). Harap tunggu hingga yang lama selesai.`,
        { parse_mode: 'HTML' }
      ).catch(() => { });
      return false;
    }

    const job = { id: this.jobCounter++, chatId, title, execFunc, addedAt: Date.now() };
    if (!this.userQueues.has(chatId)) this.userQueues.set(chatId, []);
    this.userQueues.get(chatId).push(job);

    this.checkQueue();
    return true;
  }

  updateJob(id, progressText) {
    if (this.activeJobs.has(id)) {
      this.activeJobs.get(id).progress = progressText;
    }
  }

  finishJob(id) {
    this.activeJobs.delete(id);
    this.checkQueue();
  }

  /**
   * Round-robin pick: user dengan queue non-empty + lastServed paling lama menang.
   * User yang belum pernah dilayani (never in lastServed) dapat prioritas tertinggi.
   */
  _pickNextUser() {
    let bestUser = null;
    let bestTs = Infinity;
    for (const [chatId, q] of this.userQueues.entries()) {
      if (q.length === 0) continue;
      const ts = this.userLastServed.get(chatId) ?? 0; // never = 0
      if (ts < bestTs) {
        bestTs = ts;
        bestUser = chatId;
      }
    }
    return bestUser;
  }

  async checkQueue() {
    if (this.activeJobs.size >= this.maxConcurrency) return;
    const nextUser = this._pickNextUser();
    if (nextUser == null) return;

    const q = this.userQueues.get(nextUser);
    const nextJob = q.shift();
    if (q.length === 0) this.userQueues.delete(nextUser);
    this.userLastServed.set(nextUser, Date.now());

    this.activeJobs.set(nextJob.id, {
      id: nextJob.id,
      chatId: nextJob.chatId,
      title: nextJob.title,
      progress: '⚙️ Menghubungkan...',
      status: 'Berjalan',
    });

    log.info(`[Queue] Job #${nextJob.id} user=${nextJob.chatId} "${nextJob.title.slice(0, 40)}" (active: ${this.activeJobs.size}/${this.maxConcurrency})`);
    try {
      await nextJob.execFunc(nextJob.id);
    } catch (e) {
      log.error(`Queue Job #${nextJob.id} meledak: ${e.message}`);
    } finally {
      this.finishJob(nextJob.id);
    }
  }
}

const queueManager = new DownloadQueue();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const path = require('path');
// 7zip-bin menyediakan binary 7za lintas OS agar tidak tergantung `7z` di PATH.
// Di Linux, prefer sistem `/usr/bin/7z` dari p7zip-full (lebih stabil, library sistem lengkap).
// Binary bundled dari 7zip-bin dipakai sebagai fallback (terutama Windows yang tidak punya 7z di PATH).
let PATH_7ZA = '7z';
if (process.platform !== 'linux') {
  try { PATH_7ZA = require('7zip-bin').path7za || '7z'; } catch (_) { }
}
// Modul unzipper dan node-unrar-js telah dinonaktifkan untuk menghemat RAM (Telah menggunakan native P7zip OS)
const sharp = require('sharp'); // Auto-Compressor
const cosplayteleScraper = require('./scrapers/cosplaytele');
const gofileApi = require('./scrapers/gofile');
const mediafireApi = require('./scrapers/mediafire');
const sorafolderApi = require('./scrapers/sorafolder');
const kemonoScraper = require('./scrapers/kemono');
const r34Scraper = require('./scrapers/rule34video');
const pinterestScraper = require('./scrapers/pinterest');
const javtifulScraper = require('./scrapers/javtiful');
const erothotsScraper = require('./scrapers/erothots');
const otakudesuScraper = require('./scrapers/otakudesu');
const oploverzScraper = require('./scrapers/oploverz');
const hostResolver = require('./scrapers/hostResolver');
const megaResolver = require('./scrapers/megaResolver');
const historyTracker = require('./history');
const statsDb = require('./statsDb');
const intentDetector = require('./intentDetector');
const { renderProgressBar, createProgressThrottler } = require('./utils/progressUi');
const healthcheck = require('./utils/healthcheck');
const backup = require('./utils/backup');
const dashboard = require('./utils/dashboard');

const MENU_THUMB_PATH = path.join(__dirname, 'reze.jpg');

process.env.NTBA_FIX_350 = 1; // Fix node-telegram-bot-api deprecation warning
sharp.cache(false);   // Matikan seluruh RAM cache agar RAM tidak bengkak
// sharp.concurrency(1) sudah DICABUT. Mengembalikan Sharp ke multi-thread maksimum OS agar compress lebih ngebut!



// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Admin ID dibaca dari env ADMIN_IDS (CSV). Fallback ke legacy hardcoded jika kosong.
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || '6663343995')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const isAdmin = (chatId) => ADMIN_IDS.has(String(chatId));

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ALLOWED_USER_IDS: [], // kosong = semua
  XAPIVERSE_KEY: process.env.XAPIVERSE_KEY,
  XAPIVERSE_URL: 'https://xapiverse.com/api/terabox-pro',
  LOCAL_API_URL: process.env.LOCAL_API_URL || null,
  TEMP_DIR: './tmp_downloads',
  IMAGE_EXTS: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  POSTS_PER_PAGE: 8,
  SEND_DELAY: 600,
  // Limit dinamis: 48MB untuk Telegram biasa, atau 1950MB jika pakai Local API Server
  VIDEO_MAX_BYTES: process.env.LOCAL_API_URL ? 1950 * 1024 * 1024 : 48 * 1024 * 1024,
  // Telegram: photo ~10MB hard-limit; kita pakai 9MB aman.
  PHOTO_MAX_BYTES: 9 * 1024 * 1024,
  // TTL cache state in-memory (ms): 30 menit cukup untuk satu sesi browse/gacha.
  CACHE_TTL_MS: 30 * 60 * 1000,
};

// ─── LOGGER & UTILS ──────────────────────────────────────────────────────────
const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isImage = (f) => CONFIG.IMAGE_EXTS.includes(path.extname(f).toLowerCase());
const isVideo = (f) => ['.mp4', '.mov', '.webm', '.mkv'].includes(path.extname(f).toLowerCase());
const isMedia = (f) => isImage(f) || isVideo(f);
const isArchive = (f) => ['.zip', '.rar', '.7z'].includes(path.extname(f).toLowerCase());

async function rimraf(dir) {
  if (fs.existsSync(dir)) {
    await fsp.rm(dir, { recursive: true, force: true });
    log.info(`Dihapus: ${dir}`);
  }
}

function collectFiles(dir) {
  const res = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d)) {
      const f = path.join(d, e);
      fs.statSync(f).isDirectory() ? walk(f) : res.push(f);
    }
  };
  walk(dir);
  return res.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function chunkMediaByLimits(medias) {
  const MAX_ITEMS = 10;
  // Limit gabungan upload Telegram Bot API (sekitar 90% dari MAX_BYTES agar aman terhadap metadata tambahan)
  const MAX_BYTES = Math.floor(CONFIG.VIDEO_MAX_BYTES * 0.9);

  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const mediaPath of medias) {
    const size = fs.existsSync(mediaPath) ? fs.statSync(mediaPath).size : 0;

    // Jika ada satu file yang sendirian sudah jumbo, kita paksa sendirian di chunk terpisah.
    // Atau jika batas kuota 10 biji tercapai, atau batas gabungan tercapai... potong jadi chunk baru.
    if (currentChunk.length > 0 && (currentChunk.length >= MAX_ITEMS || currentSize + size >= MAX_BYTES)) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(mediaPath);
    currentSize += size;
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

// ─── SHARP AUTO-COMPRESSOR ───────────────────────────────────────────────────
async function sanitizeMediasForTelegram(medias, statusCallback) {
  // Telegram hard-limits untuk sendPhoto:
  //   - file size ≤ 10 MB
  //   - width + height ≤ 10000 px (sum, bukan individual)
  //   - aspect ratio ≤ 20:1
  // Kalau salah satu dilanggar → 400 PHOTO_INVALID_DIMENSIONS → jatuh ke document.
  //
  // Strategy kompres yang aman:
  //   target max dimension 4096 dengan `fit:'inside'` — sharp otomatis scale down
  //   sampai BOTH width dan height ≤ 4096 sambil preserve aspect ratio.
  //   Hasil max sum = 8192 (aman di bawah 10000).
  //
  // 2-pass agar progress bar akurat.

  const TG_MAX_SUM = 10000;
  const TG_MAX_SIZE = 10 * 1024 * 1024;
  const TG_MAX_RATIO = 20;
  const TARGET_MAX_DIM = 4096; // target dimensi max setelah resize (conservative)

  const compressibleExts = ['.jpg', '.jpeg', '.png', '.webp'];
  const toCompress = []; // { index, path, meta, size }

  // Pass 1: scan
  for (let i = 0; i < medias.length; i++) {
    const mPath = medias[i];
    if (!compressibleExts.includes(path.extname(mPath).toLowerCase())) continue;
    try {
      const fStats = fs.statSync(mPath);
      const meta = await sharp(mPath).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      const sum = w + h;
      const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 1;
      const maxDim = Math.max(w, h);

      // Trigger: file > 9MB, sum > 9000, max dim > 4500, atau ratio ekstrem
      if (fStats.size > 9 * 1024 * 1024 || sum > 9000 || maxDim > 4500 || ratio > 19) {
        toCompress.push({ index: i, path: mPath, meta, size: fStats.size });
      }
    } catch (_) {
      // Skip file yang tidak bisa di-baca metadatanya (bukan image valid)
    }
  }

  if (toCompress.length === 0) return;

  log.info(`[Compress] ${toCompress.length}/${medias.length} foto perlu dikompres`);

  const startedAt = Date.now();
  const throttle = createProgressThrottler(1500);
  const updateStatus = (done, total, forceNow = false) => {
    throttle(() => {
      const txt = renderProgressBar({
        icon: '🗜️',
        title: 'Kompres foto 4K',
        done, total, unit: 'items',
        showSpeed: false,
        startedAt,
      });
      try { statusCallback(txt).catch(() => { }); } catch (_) { }
    }, forceNow);
  };

  updateStatus(0, toCompress.length, true);

  // Pass 2: compress
  for (let k = 0; k < toCompress.length; k++) {
    const { index, path: mPath, meta } = toCompress[k];
    const w = meta.width || 0;
    const h = meta.height || 0;
    const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 1;

    try {
      const outPath = mPath + '_compressed.jpg';
      let s = sharp(mPath, { failOn: 'none' });

      if (ratio > TG_MAX_RATIO - 1) {
        // Aspect extreme (narrow strip, ratio ≥19). Telegram tolak bahkan kalau sum OK.
        // Step 1: crop ke aspect 18:1 untuk masuk limit aspect Telegram.
        // Step 2: cap max dimension ke TARGET_MAX_DIM supaya sum tetap ≤ TG_MAX_SUM.
        const safeWidth = w > h ? Math.min(w, Math.floor(h * 18)) : w;
        const safeHeight = h > w ? Math.min(h, Math.floor(w * 18)) : h;
        s = s.resize({ width: safeWidth, height: safeHeight, fit: 'cover', position: 'top' })
          .resize({ width: TARGET_MAX_DIM, height: TARGET_MAX_DIM, fit: 'inside', withoutEnlargement: true });
      } else {
        // Normal case: cap kedua dimensi sekaligus dengan fit:'inside'.
        // Sharp otomatis pilih dimensi terbesar sebagai limiter + preserve aspect.
        // Hasil dijamin: max(width, height) ≤ TARGET_MAX_DIM → sum ≤ 2*TARGET_MAX_DIM.
        s = s.resize({
          width: TARGET_MAX_DIM,
          height: TARGET_MAX_DIM,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      await s.jpeg({ quality: 82, mozjpeg: true }).toFile(outPath);

      // Verifikasi hasil sesuai spec Telegram. Kalau ukuran file masih > 10MB,
      // kompres ulang dengan quality lebih agresif (55).
      let outSize = fs.statSync(outPath).size;
      if (outSize > TG_MAX_SIZE) {
        await sharp(outPath, { failOn: 'none' }).jpeg({ quality: 55, mozjpeg: true }).toFile(outPath + '.tmp');
        fs.renameSync(outPath + '.tmp', outPath);
        outSize = fs.statSync(outPath).size;
        log.warn(`[Compress] ${path.basename(mPath)} terlalu besar setelah kompres, re-encode quality 55 → ${(outSize / 1048576).toFixed(1)} MB`);
      }

      medias[index] = outPath;

      await new Promise(res => setTimeout(res, 50));
      global.gc && global.gc();
    } catch (err) {
      log.warn(`[Compress] skip ${path.basename(mPath)}: ${err.message}`);
    }

    updateStatus(k + 1, toCompress.length, k === toCompress.length - 1);
  }

  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.ok(`[Compress] Selesai: ${toCompress.length} foto dalam ${elapsedTotal}s`);
}

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────
// Format: chatId -> { step: 'AWAITING_SOURCE' | 'AWAITING_PASSWORD', url: string }
const userStates = new Map();
const browseCache = new Map(); // chatId -> { posts: [], page, category, query }
const menuTracker = new Map(); // chatId -> lastMessageId (Untuk auto-clean menu lama)
const kemonoTracker = new Map(); // chatId -> array of message_ids (Untuk auto-clean media gacha)
const r34BrowseCache = new Map(); // chatId -> { posts: [], page, query }
const pinBrowseCache = new Map(); // chatId -> { pins: [], query, nextBookmark, prevBookmarks: [] }
const javBrowseCache = new Map(); // chatId -> { items: [], query, page, hasNext }
const eroBrowseCache = new Map(); // chatId -> { items: [], query, page, hasNext }
const animeBrowseCache = new Map(); // chatId -> { results, episodes, seriesIdx, oploLinks, oploEpNum }
const aggregateCache = new Map(); // chatId -> { query, sources: { cosplay: [], r34: [], pinterest: [] } }

// Last-seen timestamp untuk TTL cleanup agar Map di atas tidak tumbuh monotonic seumur uptime VPS.
const stateTouchedAt = new Map(); // chatId -> ms timestamp terakhir touch
function touchState(chatId) {
  stateTouchedAt.set(chatId, Date.now());
}
// Bungkus .set pada tiap Map supaya otomatis update timestamp tiap kali state user disentuh.
// Lebih ringkas & anti-miss daripada menaruh touchState() di puluhan call-site.
for (const m of [userStates, browseCache, menuTracker, kemonoTracker, r34BrowseCache, pinBrowseCache, javBrowseCache, eroBrowseCache, animeBrowseCache, aggregateCache]) {
  const origSet = m.set.bind(m);
  m.set = (key, value) => {
    touchState(key);
    return origSet(key, value);
  };
}
function sweepStaleStates() {
  const now = Date.now();
  for (const [chatId, ts] of stateTouchedAt.entries()) {
    if (now - ts < CONFIG.CACHE_TTL_MS) continue;
    userStates.delete(chatId);
    browseCache.delete(chatId);
    menuTracker.delete(chatId);
    kemonoTracker.delete(chatId);
    r34BrowseCache.delete(chatId);
    pinBrowseCache.delete(chatId);
    javBrowseCache.delete(chatId);
    eroBrowseCache.delete(chatId);
    aggregateCache.delete(chatId);
    stateTouchedAt.delete(chatId);
  }
}
// Jalankan setiap 5 menit. unref() agar interval tidak block process exit.
setInterval(sweepStaleStates, 5 * 60 * 1000).unref();

// ─── ADMIN STATS TRACKER ─────────────────────────────────────────────────────
const botStats = {
  startTime: Date.now(),
  downloadedBytes: 0,
  extractedFiles: 0,
  totalJobs: 0
};

// Escape HTML entities agar Telegram tidak crash saat judul mengandung < atau >
function escHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function autoCleanOldMenu(bot, chatId, newMsgId) {
  const oldId = menuTracker.get(chatId);
  // Hapus menu lama jika ada
  if (oldId && oldId !== newMsgId) {
    bot.deleteMessage(chatId, oldId).catch(() => { });
  }
  menuTracker.set(chatId, newMsgId);
}

// ─── TERABOX DOWNLOAD PIPELINE ───────────────────────────────────────────────
async function getApiResult(teraboxUrl) {
  const { data } = await axios.post(CONFIG.XAPIVERSE_URL, { url: teraboxUrl }, {
    headers: { 'Content-Type': 'application/json', 'xAPIverse-Key': CONFIG.XAPIVERSE_KEY },
    timeout: 30000,
  });
  if (!data.list || !data.list.length) return null;
  const item = data.list[0];
  return {
    zipDlink: item.zip_dlink || null,
    name: item.name || 'archive',
    sizeMB: (item.size / 1024 / 1024).toFixed(1),
    credits: data.free_credits_remaining || '?',
  };
}

async function _downloadStreamOnce(url, destPath, onProgress, cookie = null, opts = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

  let res;
  try {
    res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 600000, headers, validateStatus: () => true });
  } catch (e) {
    // Network/DNS error — wrap agar retry loop bisa deteksi
    const err = new Error(e.message);
    err.isNetworkError = true;
    throw err;
  }

  // Tangani HTTP error eksplisit (429, 5xx, 403) agar retry loop bisa decide.
  if (res.status >= 400) {
    try { res.data.destroy(); } catch (_) { }
    const err = new Error(`Request failed with status code ${res.status}`);
    err.httpStatus = res.status;
    err.retryAfter = parseInt(res.headers['retry-after'] || '0', 10) || 0;
    throw err;
  }

  // Validasi content-type untuk cegah file HTML error (Kemono 403/rate-limit, Gofile link expired) disimpan sbg .jpg/.rar.
  // Aktif hanya jika pemanggil opt-in lewat opts.expectMedia atau opts.expectBinary.
  if (opts.expectMedia || opts.expectBinary) {
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    // Tolak text/html + text/plain + application/json (error page dari CDN)
    const bad = ct.startsWith('text/') || ct.startsWith('application/json') || ct.startsWith('application/xhtml');
    if (bad) {
      res.data.destroy();
      throw new Error(`Link expired atau session invalid (server balas ${ct || 'unknown'} bukan file). Coba klik Download ulang dari menu.`);
    }
    // Untuk expectMedia (image/video), cek lebih ketat
    if (opts.expectMedia) {
      const ok = ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('application/octet-stream') || ct.startsWith('binary/');
      if (!ok) {
        res.data.destroy();
        throw new Error(`Bukan media (content-type=${ct || 'unknown'})`);
      }
    }
  }

  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0, lastPct = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    res.data.pipe(writer);
    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      botStats.downloadedBytes += chunk.length; // TRACKING TRAFIK
      if (total > 0 && onProgress) {
        const pct = Math.floor((downloaded / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; onProgress(pct, downloaded, total); }
      }
    });
    writer.on('finish', () => { writer.close(); resolve(); });
    writer.on('error', (err) => {
      writer.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/**
 * Wrapper dengan retry exponential-backoff untuk 429 (rate-limit) dan 5xx.
 * Retry max 3x, delay awal 2s → 4s → 8s, atau pakai header `Retry-After` dari server.
 * Error non-transient (HTML response, 4xx selain 429, filesystem) langsung dilempar tanpa retry.
 */
async function downloadStream(url, destPath, onProgress, cookie = null, opts = {}) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await _downloadStreamOnce(url, destPath, onProgress, cookie, opts);
      return;
    } catch (e) {
      lastErr = e;
      const retriable = e.httpStatus === 429 || (e.httpStatus >= 500 && e.httpStatus < 600) || e.isNetworkError;
      if (!retriable || attempt === MAX_RETRIES) throw e;

      // Retry-After header (detik) > exponential fallback (2/4/8s).
      const backoff = e.retryAfter > 0 ? Math.min(e.retryAfter * 1000, 60000) : Math.pow(2, attempt) * 1000;
      log.warn(`[downloadStream] HTTP ${e.httpStatus || 'net'} pada attempt ${attempt}/${MAX_RETRIES}, retry dalam ${backoff}ms: ${url.slice(0, 100)}`);
      await sleep(backoff);
      // Hapus partial file sebelum retry agar tidak korup.
      if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
    }
  }
  throw lastErr;
}

/**
 * Validasi magic-byte arsip. Return true jika header cocok ekstensi.
 * ZIP : 50 4B 03 04 | 50 4B 05 06 | 50 4B 07 08
 * RAR4: 52 61 72 21 1A 07 00
 * RAR5: 52 61 72 21 1A 07 01 00
 * 7Z  : 37 7A BC AF 27 1C
 */
function isLikelyValidArchive(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    const read = fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (read < 4) return false;

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip') {
      return buf[0] === 0x50 && buf[1] === 0x4B &&
        ((buf[2] === 0x03 && buf[3] === 0x04) ||
          (buf[2] === 0x05 && buf[3] === 0x06) ||
          (buf[2] === 0x07 && buf[3] === 0x08));
    }
    if (ext === '.rar') {
      return buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
        buf[4] === 0x1A && buf[5] === 0x07;
    }
    if (ext === '.7z') {
      return buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF &&
        buf[4] === 0x27 && buf[5] === 0x1C;
    }
    return true; // ekstensi non-arsip, biarkan lolos
  } catch (e) {
    return false;
  }
}

async function extractArchive(archivePath, destDir, password = null) {
  await fsp.mkdir(destDir, { recursive: true });
  const ext = path.extname(archivePath).toLowerCase();
  const { spawnSync } = require('child_process');

  // Password candidates order:
  // 1. Yang dilewatkan caller (scraped dari post / input user) → paling prioritas
  // 2. Dari env ARCHIVE_PASSWORDS (CSV), untuk override global tanpa edit kode
  // 3. Daftar default diketahui (cosplaytele.com paling umum saat ini, lalu varian lama)
  // 4. null (arsip tanpa password)
  const envPasswords = String(process.env.ARCHIVE_PASSWORDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const defaults = ['cosplaytele.com', 'Cosplaytele.com', 'cosplaytele', 'Cosplaytele', '4KHD', '4khd', 'oploverz.me'];
  const candidates = [password, ...envPasswords, ...defaults, null]
    .filter((p, i, arr) => arr.indexOf(p) === i); // dedup

  if (ext === '.zip' || ext === '.rar' || ext === '.7z') {
    let success = false;
    let lastStderr = '';
    // Helper untuk mask password: tampilkan 2 char pertama + panjang agar user bisa bedakan
    // mana yang sedang dicoba, tanpa echo plaintext ke console.
    const maskPw = (pw) => pw ? `${pw.slice(0, 2)}***(len=${pw.length})` : 'none';

    // Urutan tool per-ekstensi:
    //   .rar  → unrar (native, support semua compression method RAR5) → 7z (fallback)
    //   .zip  → 7z (native zip support sempurna)
    //   .7z   → 7z (native)
    // Alasan: p7zip di Linux kadang tidak support RAR5 method tertentu (BLAKE2, PPMd)
    // → "Unsupported Method" walau password benar. Unrar dari WinRAR team handle semua.
    const tools = ext === '.rar' ? ['unrar', '7z'] : ['7z', 'unrar'];

    const run7z = (pw) => {
      const args = ['x', archivePath];
      if (pw) args.push(`-p${pw}`); else args.push('-p');
      args.push(`-o${destDir}`, '-y');
      return spawnSync(PATH_7ZA, args, { encoding: 'utf8' });
    };
    const runUnrar = (pw) => {
      if (ext !== '.rar') return { status: -1, stderr: 'unrar hanya untuk .rar' };
      const args = ['x', '-y'];
      args.push(pw ? `-p${pw}` : '-p-');
      args.push(archivePath, `${destDir}/`);
      return spawnSync('unrar', args, { encoding: 'utf8' });
    };

    outer: for (const pw of candidates) {
      const pwMask = maskPw(pw);
      for (const tool of tools) {
        try {
          const r = tool === 'unrar' ? runUnrar(pw) : run7z(pw);
          if (r.status === 0) {
            success = true;
            log.ok(`Archive extracted via ${tool} (ext=${ext}, pw=${pwMask})`);
            break outer;
          }
          // Non-zero exit: catat untuk diagnostic
          if (r.status === -1) continue; // unrar skipped untuk non-rar
          lastStderr = String(r.stderr || r.stdout || '').slice(0, 300);
          const signal = r.signal ? ` signal=${r.signal}` : '';
          const errLine = lastStderr.split('\n').find(l => l.includes('ERROR') || l.includes('Wrong') || l.includes('Cannot') || l.includes('Unsupported'));
          const hint = (r.status === null && !r.signal && !errLine)
            ? '(binary tidak jalan: kemungkinan rusak/tidak executable)'
            : (errLine || lastStderr.slice(0, 120) || '(no stderr)');
          // Kalau tool pertama gagal karena "Unsupported Method" / "Wrong password",
          // stop coba tool kedua untuk pw ini — tool selanjutnya bakal handle.
          log.warn(`[${tool}] pw=${pwMask} → exit=${r.status}${signal}: ${hint}`);
        } catch (e) {
          lastStderr = e.message;
          log.warn(`[${tool}] pw=${pwMask} → spawn error: ${e.message}`);
        }
      }
    }
    if (!success) {
      const hint = lastStderr.toLowerCase().includes('wrong password')
        ? 'password tidak cocok'
        : (lastStderr.toLowerCase().includes('unsupported method') ? 'archive pakai compression method yang tidak didukung (upgrade p7zip atau install unrar non-free)'
          : (lastStderr.toLowerCase().includes('headers error') ? 'header terenkripsi / password salah di header-level' : 'file korup'));
      throw new Error(`Gagal ekstrak arsip '${path.basename(archivePath)}' — ${hint}. Detail: ${lastStderr.slice(0, 160)}`);
    }
  }

  // Nested extract
  for (const file of collectFiles(destDir)) {
    if (!isArchive(file)) continue;
    const subDir = file.replace(/\.[^.]+$/, '_x');
    try {
      await extractArchive(file, subDir, password);
      fs.unlinkSync(file);
    } catch (e) { log.warn(`Nested extract fail: ${e.message}`); }
  }
}

async function sendOne(bot, chatId, filePath, explicitCaption = null) {
  const size = fs.statSync(filePath).size;
  const name = path.basename(filePath);
  const finalCaption = explicitCaption !== null ? explicitCaption : name;

  if (size > CONFIG.VIDEO_MAX_BYTES) {
    const sizeMB = (size / 1048576).toFixed(1);
    const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1048576);
    log.warn(`[sendOne] SKIP ${name} (${sizeMB} MB > limit ${limitMB} MB)`);
    try {
      await bot.sendMessage(chatId,
        `⚠️ <b>${escHtml(name)}</b> ${sizeMB} MB melebihi limit upload ${limitMB} MB, file dilewati.`,
        { parse_mode: 'HTML' });
    } catch (_) { }
    return;
  }

  if (isVideo(filePath) && size < CONFIG.VIDEO_MAX_BYTES) {
    try {
      await bot.sendVideo(chatId, fs.createReadStream(filePath), { caption: finalCaption });
    } catch (e) {
      log.warn(`Gagal sendVideo (${name}), fallback doc: ${e.message}`);
      try { await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption }); } catch (_) { }
    }
  } else if (isImage(filePath) && size < CONFIG.PHOTO_MAX_BYTES) {
    try {
      // Kirim sebagai foto dari stream
      await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: finalCaption });
    }
    catch (e) {
      try {
        log.warn(`Gagal sendPhoto (${name}), fallback document: ${e.message}`);
        await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption });
      } catch (_) { }
    }
  } else {
    try { await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption }); } catch (_) { }
  }
}

async function processDownload(bot, chatId, url, password, source = 'terabox', jobId = null, opts = {}) {
  log.info(`[User ${chatId}] Memulai processDownload: ${url}`);
  const tmpBase = path.join(CONFIG.TEMP_DIR, `job_${Date.now()}`);
  let zipPath = `${tmpBase}_raw.zip`;
  const unzipDir = `${tmpBase}_ext`;
  let statusMsg = null;
  const status = async (txt) => {
    try {
      if (statusMsg) await bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
      else statusMsg = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
    } catch (_) { }
  };

  try {
    await fsp.mkdir(CONFIG.TEMP_DIR, { recursive: true });

    let downloadLink = '';
    let fileName = '';
    let cookie = '';
    let accountToken = opts.accountToken || null;
    zipPath = '';

    if (source === 'gofile') {
      await status('⚙️ <b>Memproses isi link Gofile...</b>');
      log.info(`[Process] Memeriksa isi Gofile lewat Playwright...`);
      const gofileRes = await gofileApi.resolveGofile(url);
      if (!gofileRes || gofileRes.files.length === 0) {
        log.warn(`[Process] Resolving Gofile gagal / kosong: ${url}`);
        return status('❌ Gagal meresolve isi Gofile, atau folder kosong.');
      }

      let targetFile;
      // Jika gofileRes.files dilempar dari button spesifik, kita cari id-nya. 
      // Tapi karena saat ini processDownload menerima `url` yang merupakan base url (misal gofile.io/d/123),
      // kalau ada M>1 file di dalam, bot seharusnya bertanya dulu.
      // Kita asumsikan saat memanggil `processDownload`, jika url mengandung "#file=", kita pilih spesifik.
      const fMatch = url.match(/#file=(.+)$/);
      if (fMatch) {
        targetFile = gofileRes.files.find(f => f.id === fMatch[1]);
      } else if (gofileRes.files.length === 1) {
        targetFile = gofileRes.files[0];
      } else {
        // Terdapat >1 file and tidak ada url/#file spesifik. Tampilkan opsi:
        let textOpts = `📁 <b>Terdapat ${gofileRes.files.length} file di Gofile.</b>\nPilih file yang ingin didownload:\n\n`;
        const btns = [];
        gofileRes.files.forEach((f, i) => {
          btns.push([{ text: `⬇️ ${f.name}`, callback_data: `dls_gofile_${f.id}` }]);
        });

        // Simpan url utama + files + cookie + accountToken (wajib untuk download CDN).
        userStates.set(chatId, {
          step: 'SELECT_GOFILE_FILE',
          url: url,
          files: gofileRes.files,
          cookie: gofileRes.cookie,
          accountToken: gofileRes.accountToken,
        });

        await bot.editMessageText(textOpts, {
          chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: btns }
        });
        return; // Hentikan di sini.
      }

      if (!targetFile) return status('❌ File tidak ditemukan di dalam Gofile.');

      downloadLink = targetFile.link;
      fileName = targetFile.name || 'gofile_archive.zip';
      cookie = gofileRes.cookie;
      accountToken = gofileRes.accountToken;
      zipPath = `${tmpBase}_raw${path.extname(fileName)}`;
    } else if (source === 'gofile_direct') {
      // Link CDN Gofile langsung (store*.gofile.io/download/web/...) dengan accountToken
      // dari resolve sebelumnya (dari callback dls_gofile_*). Bypass resolve Playwright
      // biar tidak double-launch browser + tidak terkena rate-limit resolve.
      await status('⚙️ <b>Menyambungkan tautan Gofile CDN...</b>');
      downloadLink = url;
      fileName = opts.fileName || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'archive.rar';
      zipPath = `${tmpBase}_raw${path.extname(fileName)}`;
      cookie = opts.cookie || '';
      accountToken = opts.accountToken || accountToken;
    } else if (source === 'direct') {
      await status('⚙️ <b>Menyambungkan tautan aslinya...</b>');
      downloadLink = url;
      // Gunakan nama akhir dari url jika memungkinkan
      fileName = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'archive.zip';
      zipPath = `${tmpBase}_raw${path.extname(fileName)}`;
      // Gofile direct CDN butuh cookie dari session resolver (accountToken). Kalau caller kasih
      // cookie via opts.cookie, pakai; tanpa itu server balas HTML 12KB (login/error page).
      if (opts.cookie) cookie = opts.cookie;
    } else {
      await status('⚙️ <b>Mapping via xAPIverse...</b>');
      const api = await getApiResult(url);
      if (!api || !api.zipDlink) return status('❌ API Gagal / Kuota Habis.');
      downloadLink = api.zipDlink;
      fileName = api.name;
    }

    await status(`⬇️ <b>Mengunduh ${fileName}...</b>\n📦`);
    // expectBinary hanya untuk file non-media (arsip) agar HTML error page ditolak di layer HTTP.
    // Untuk media (mp4/jpg/dll), biarkan lewat karena beberapa CDN balas `application/octet-stream`.
    const dlExt = path.extname(fileName).toLowerCase();
    const isArchiveTarget = ['.zip', '.rar', '.7z'].includes(dlExt);

    // Khusus Gofile CDN: butuh Authorization Bearer token + axios streaming untuk file 1GB+.
    if (/gofile\.io/i.test(downloadLink)) {
      log.info(`[Gofile] Download via axios streaming + Bearer token: ${path.basename(zipPath)}`);
      const dlStartedAt = Date.now();
      let lastLogMB = 0;
      const throttle = createProgressThrottler(2500);

      await gofileApi.downloadGofileFile(downloadLink, zipPath, (dlBytes, totBytes) => {
        const mb = dlBytes / 1048576;
        const isFinal = totBytes && dlBytes === totBytes;

        // Console log heartbeat (setiap 25MB atau final tick)
        if (mb - lastLogMB >= 25 || isFinal) {
          const elapsed = (Date.now() - dlStartedAt) / 1000;
          const spdMBs = elapsed > 0 ? (mb / elapsed).toFixed(1) : '0.0';
          const pct = totBytes ? ((dlBytes / totBytes) * 100).toFixed(1) + '%' : '?';
          log.info(`[Gofile] ${mb.toFixed(1)} / ${totBytes ? (totBytes / 1048576).toFixed(1) : '?'} MB (${pct}) @ ${spdMBs} MB/s`);
          lastLogMB = mb;
        }

        throttle(() => {
          const pText = renderProgressBar({
            icon: '⬇️',
            title: fileName,
            done: dlBytes,
            total: totBytes,
            unit: 'bytes',
            startedAt: dlStartedAt,
          });
          if (jobId) queueManager.updateJob(jobId, pText);
          status(pText).catch(() => { });
        }, isFinal);
      }, accountToken);
      // Tracking trafik ke botStats (biasanya ditangani downloadStream)
      if (fs.existsSync(zipPath)) {
        const finalMB = fs.statSync(zipPath).size / 1048576;
        log.ok(`[Gofile] Download selesai: ${finalMB.toFixed(1)} MB → ${path.basename(zipPath)}`);
        botStats.downloadedBytes += fs.statSync(zipPath).size;
      }
    } else {
      // Gofile CDN kadang validasi Referer/UA. Kirim header yg match session browser resolver.
      const dlExtra = {};
      await downloadStream(downloadLink, zipPath, async (pct, dl, tot) => {
        const pText = `⬇️ <b>Mengunduh ${fileName}...</b>\n<code>${pct}%  ─  ${(dl / 1048576).toFixed(1)} MB / ${(tot ? (tot / 1048576).toFixed(1) : '?')} MB</code>`;
        if (jobId) queueManager.updateJob(jobId, pText);
        await status(pText);
      }, cookie, { expectBinary: isArchiveTarget, ...dlExtra });
    }

    const finalSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    if (finalSize > 0) statsDb.addDownloadSize(chatId, finalSize);

    // Sanity check ukuran: file arsip <50 KB hampir pasti HTML error page / truncated.
    if (isArchiveTarget && finalSize > 0 && finalSize < 50 * 1024) {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      return status(`❌ <b>Download gagal.</b> Link CDN balik ukuran ${(finalSize / 1024).toFixed(0)}KB (terlalu kecil, kemungkinan link expired/rate-limited). Coba klik Download lagi dari menu.`);
    }

    // Validate magic-byte: tolak file yang ekstensinya .zip/.rar/.7z tapi isinya bukan arsip (HTML/JSON error).
    if (isArchiveTarget && !isLikelyValidArchive(zipPath)) {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      return status(`❌ <b>File korup.</b> Yang terdownload bukan arsip valid (kemungkinan link expired atau session Gofile bocor). Coba klik Download lagi.`);
    }

    // Tandai status jadi Ekstraksi
    if (jobId) queueManager.updateJob(jobId, '📦 Mengekstrak berkas arsip...');

    log.info(`[Process] File siap diproses: ${path.basename(zipPath)} (${(fs.existsSync(zipPath) ? fs.statSync(zipPath).size / 1024 : 0).toFixed(0)} KB)`);
    let fallbackRaw = false;

    if (isArchive(zipPath)) {
      await status('📦 <b>Mengekstrak arsip...</b>');
      try {
        await extractArchive(zipPath, unzipDir, password);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch (extErr) {
        log.warn(`Ekstraksi gagal: ${extErr.message}, mengirim mentahan...`);
        // Kalau arsip oversize lebih besar dari limit Telegram, kirim dokumen mentahan
        // akan silent-skip di sendOne (size > VIDEO_MAX_BYTES) — jadi user gak dapat apa-apa.
        // Berikan pesan jelas + link download manual alih-alih silent-fail.
        const archSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
        const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024);
        if (archSize > CONFIG.VIDEO_MAX_BYTES) {
          const sizeMB = (archSize / 1024 / 1024).toFixed(1);
          await status(
            `⚠️ <b>Password arsip tidak cocok</b> dan file <b>${sizeMB}MB</b> melebihi limit upload ${limitMB}MB.\n\n` +
            `Silakan download manual via link asli:\n<code>${escHtml(url)}</code>\n\n` +
            `Lalu extract pakai salah satu password: <code>cosplaytele.com</code>, <code>cosplaytele</code>, <code>4KHD</code>.\n` +
            `Atau set password custom di env <code>ARCHIVE_PASSWORDS=pw1,pw2</code>.`
          );
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          await rimraf(unzipDir);
          return;
        }
        await status(`⚠️ <b>Gagal ekstrak arsip.</b> Mengirim file mentahan (${(archSize / 1024 / 1024).toFixed(1)}MB) langsung...`);
        if (!fs.existsSync(unzipDir)) fs.mkdirSync(unzipDir);
        fs.renameSync(zipPath, path.join(unzipDir, path.basename(zipPath)));
        fallbackRaw = true; // Tandai bahwa ini file mentahan, jangan filter!
      }
    } else {
      // Bukan arsip (contoh: unduhan file .mp4 langsung), pindahkan agar tetap dikirim
      if (!fs.existsSync(unzipDir)) fs.mkdirSync(unzipDir);
      fs.renameSync(zipPath, path.join(unzipDir, path.basename(zipPath)));
    }

    const files = collectFiles(unzipDir);
    const medias = files.filter(isMedia);
    // Jika fallbackRaw, kirim SEMUA file termasuk arsip mentahan sebagai dokumen
    const docs = fallbackRaw
      ? files.filter(f => !isMedia(f))
      : files.filter(f => !isMedia(f) && !isArchive(f));
    const total = medias.length + docs.length;

    if (total === 0) return status('⚠️ Arsip kosong atau berpassword proteksi tingkat tinggi.');
    botStats.totalJobs += 1; // TRACKING KERJAAN
    botStats.extractedFiles += total; // TRACKING JUMLAH FILE

    // Auto-compressor Sharp Engine (Pre-flight checks) sebelum masuk antiller
    await sanitizeMediasForTelegram(medias, status);

    const totalSizeMB = [...medias, ...docs].reduce((s, f) => s + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0) / 1048576;
    log.info(`[Send] Mulai kirim: ${medias.length} media + ${docs.length} doc = ${total} file, total ${totalSizeMB.toFixed(1)} MB`);
    await status(`📤 <b>Mengirim ${total} file (${totalSizeMB.toFixed(0)} MB)...</b>`);

    const sendStartedAt = Date.now();
    let sent = 0;
    const mediaChunks = chunkMediaByLimits(medias);
    let isFirstBatch = true; // Untuk memastikan caption hanya ditambahkan 1x

    // 1. Mengirim gambar/video secara massal (Media Group)
    for (let chunkIdx = 0; chunkIdx < mediaChunks.length; chunkIdx++) {
      const chunk = mediaChunks[chunkIdx];
      const chunkSize = chunk.reduce((s, f) => s + fs.statSync(f).size, 0);
      const chunkMB = (chunkSize / 1048576).toFixed(1);
      log.info(`[Send] Album ${chunkIdx + 1}/${mediaChunks.length}: ${chunk.length} item, ${chunkMB} MB`);

      const mediaGroup = chunk.map((mediaPath, idx) => {
        const obj = {
          type: isVideo(mediaPath) ? 'video' : 'photo',
          media: fs.createReadStream(mediaPath)
        };
        if (isFirstBatch && idx === 0) {
          obj.caption = fileName;
        }
        return obj;
      });

      const t0 = Date.now();
      try {
        await bot.sendMediaGroup(chatId, mediaGroup);
        sent += chunk.length;
        log.ok(`[Send] Album ${chunkIdx + 1}/${mediaChunks.length} terkirim (${((Date.now() - t0) / 1000).toFixed(1)}s) — progress ${sent}/${total}`);
      } catch (err) {
        log.warn(`[Send] sendMediaGroup ${chunkIdx + 1}/${mediaChunks.length} gagal (${err.message}), fallback per-item...`);
        for (let idx = 0; idx < chunk.length; idx++) {
          const caption = (isFirstBatch && idx === 0) ? fileName : '';
          try {
            await sendOne(bot, chatId, chunk[idx], caption);
            sent++;
            log.info(`[Send]   fallback: ${path.basename(chunk[idx])} OK (${sent}/${total})`);
          } catch (itemErr) {
            log.error(`[Send]   fallback ${path.basename(chunk[idx])} GAGAL: ${itemErr.message}`);
          }
        }
      }
      isFirstBatch = false;
      await status(`📤 <b>Mengirim... ${sent}/${total}</b>`).catch(() => { });
      await sleep(CONFIG.SEND_DELAY * 2); // delay sedikit agar tidak limit di Telegram
    }

    // 2. Mengirim file / dokumen (Jika ada)
    if (docs.length > 0) log.info(`[Send] Mengirim ${docs.length} dokumen...`);
    for (const d of docs) {
      const dSize = (fs.statSync(d).size / 1048576).toFixed(1);
      const t0 = Date.now();
      try {
        await sendOne(bot, chatId, d);
        sent++;
        log.ok(`[Send] Doc: ${path.basename(d)} (${dSize} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s) — progress ${sent}/${total}`);
      } catch (e) {
        log.error(`[Send] Doc ${path.basename(d)} GAGAL: ${e.message}`);
      }
      await sleep(CONFIG.SEND_DELAY);
    }

    const elapsed = ((Date.now() - sendStartedAt) / 1000).toFixed(1);
    const avgMBps = totalSizeMB > 0 ? (totalSizeMB / (elapsed || 1)).toFixed(1) : '0';
    log.ok(`[Send] SELESAI: ${sent}/${total} file terkirim dalam ${elapsed}s (~${avgMBps} MB/s) untuk user ${chatId}`);
    await status(`✅ <b>Selesai!</b> Terkirim ${sent}/${total} file (${totalSizeMB.toFixed(0)} MB) dalam ${elapsed}s.\n<i>(Pesan status ini akan musnah dalam 5 detik..)</i>`);

    // Fitur Auto-Clean: Hapus pesan status download setelah 5 detik agar riwayat chat bersih
    setTimeout(() => {
      if (statusMsg) bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
    }, 5000);

    // Bersihkan folder temp SETELAH pengiriman selesai
    await rimraf(unzipDir);

  } catch (err) {
    log.error(`[User ${chatId}] processDownload gagal: ${err.message}`);
    log.error(`[User ${chatId}] Stack: ${err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : 'n/a'}`);

    // Pesan actionable khusus untuk error yang sering muncul
    let userMsg = `❌ <b>Error:</b> <code>${escHtml(err.message.slice(0, 300))}</code>`;
    if (/Monthly download limit exceeded|1000GB per 30 days/i.test(err.message)) {
      userMsg = `❌ <b>Kuota Gofile VPS habis</b>\n\n` +
        `Gofile batasi <b>1000 GB/30 hari per IP</b>. IP VPS sekarang sudah over quota — rolling window, reset 30 hari dari download pertama.\n\n` +
        `<b>Solusi:</b>\n` +
        `• Aktifkan proxy (WARP) di VPS untuk rotate IP\n` +
        `• Tunggu quota reset\n` +
        `• Download manual dari link asli`;
    } else if (/HTTP 429/i.test(err.message)) {
      userMsg = `❌ <b>Gofile rate-limit.</b> Server CDN menolak 3x berturut-turut.\n<code>${escHtml(err.message.slice(0, 200))}</code>`;
    } else if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)) {
      userMsg = `❌ <b>Koneksi ke server gagal.</b> Cek koneksi internet VPS.\n<code>${escHtml(err.message.slice(0, 200))}</code>`;
    }
    await status(userMsg);
    await rimraf(unzipDir); // Bersihkan juga di catch kalau ada error lain
  } finally {
    // Hanya hapus file zip saja di sini (kalau masih ada)
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

// ─── COSPLAYTELE MAPPING HANDLERS ──────────────────────────────────────────────
async function sendPostDetail(bot, chatId, loadMsg, post, cacheIndex) {
  const links = await cosplayteleScraper.scrapePostDetail(post.url);
  if (!links) {
    return bot.editMessageText('❌ Gagal memuat detail post.', {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_browse' }]] },
    }).catch(() => { });
  }

  // Merge metadata: listing-level fields (dari parseAriaLabel) + detail-level
  const meta = links.meta || {};
  const cosplayer = post.cosplayer || meta.cosplayer;
  const character = post.character || meta.character;
  const series = post.series || meta.series;
  const photoCount = post.photoCount ?? meta.photoCount;
  const videoCount = post.videoCount ?? meta.videoCount;

  // Pakai thumb dari detail (biasanya lebih HD) kalau ada, fallback post.thumb
  const thumb = links.thumb || post.thumb;

  // Bangun caption
  let resText = '';
  if (character || cosplayer) {
    if (character) resText += `✨ <b>${escHtml(character)}</b>`;
    if (series) resText += ` · <i>${escHtml(series)}</i>`;
    resText += `\n`;
    if (cosplayer) resText += `👤 ${escHtml(cosplayer)}\n`;
  } else {
    resText += `✨ <b>${escHtml(post.title)}</b>\n`;
  }

  const statsLine = [];
  if (photoCount) statsLine.push(`📸 ${photoCount} foto`);
  if (videoCount) statsLine.push(`🎬 ${videoCount} video`);
  if (statsLine.length) resText += `${statsLine.join(' · ')}\n`;

  // Download links info
  resText += `\n<b>Links:</b>\n`;
  if (links.gofile) resText += `📁 Gofile\n`;
  if (links.mediafire) resText += `🔥 MediaFire\n`;
  if (links.sorafolder) resText += `🌤️ SoraFolder\n`;
  if (links.terabox) resText += `📥 TeraBox: <code>${escHtml(links.terabox.slice(0, 60))}</code>\n`;
  if (!links.gofile && !links.mediafire && !links.sorafolder && !links.terabox) {
    resText += `<i>Tidak ada link download terdeteksi.</i>\n`;
  }

  if (links.password) resText += `\n🔑 Password: <code>${escHtml(links.password)}</code>\n`;

  // Build buttons
  const dlButtons = [];

  // Download auto (pakai existing callback names agar backward compat)
  if (links.gofile) dlButtons.push([{ text: '⬇️ Download via Gofile (Auto)', callback_data: `dlgofile_${cacheIndex}` }]);
  if (links.mediafire) dlButtons.push([{ text: '⬇️ Download via MediaFire (Auto)', callback_data: `dlmediafire_${cacheIndex}` }]);
  if (links.sorafolder) dlButtons.push([{ text: '⬇️ Download via SoraFolder (Auto)', callback_data: `dlsorafolder_${cacheIndex}` }]);

  // Preview gallery (kalau ada ≥3 image)
  if (links.previewImages && links.previewImages.length >= 3) {
    dlButtons.push([{ text: `👀 Preview (${links.previewImages.length} foto sampel)`, callback_data: `cptprev_${cacheIndex}` }]);
  }

  // Explore: browse by cosplayer / character / series
  if (links.cosplayerSlug) {
    dlButtons.push([{ text: `👤 More from ${(cosplayer || 'Cosplayer').slice(0, 25)}`, callback_data: `cptcos_${links.cosplayerSlug}` }]);
  }
  // Character + series tag buttons side-by-side
  const tagRow = [];
  if (links.characterTag) {
    tagRow.push({ text: `🏷️ ${links.characterTag.name.slice(0, 20)}`, callback_data: `cpttag_${links.characterTag.slug}` });
  }
  if (links.seriesTag && links.seriesTag.slug !== links.characterTag?.slug) {
    tagRow.push({ text: `🏷️ ${links.seriesTag.name.slice(0, 20)}`, callback_data: `cpttag_${links.seriesTag.slug}` });
  }
  if (tagRow.length) dlButtons.push(tagRow);

  // Back navigation
  const stateInfo = browseCache.get(chatId);
  if (stateInfo && stateInfo.isGacha) {
    dlButtons.push([
      { text: '🎲 Gacha Lagi', callback_data: 'menu_gacha' },
      { text: '🔙 Menu', callback_data: 'menu_awal' },
    ]);
  } else {
    dlButtons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'back_browse' }]);
  }

  // Cache detail untuk callback preview / downloads
  const cache = browseCache.get(chatId) || { posts: [], page: 1, category: 'home' };
  cache.detailCache = cache.detailCache || {};
  cache.detailCache[cacheIndex] = links;
  browseCache.set(chatId, cache);

  const replyMarkupObj = { inline_keyboard: dlButtons };

  try {
    if (thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      await bot.sendPhoto(chatId, thumb, {
        caption: resText, parse_mode: 'HTML', reply_markup: replyMarkupObj,
      });
    } else {
      await bot.editMessageText(resText, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: replyMarkupObj,
      });
    }
  } catch (err) {
    log.warn(`[Cosplaytele] Gagal kirim preview: ${err.message}`);
    bot.editMessageText(resText, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: replyMarkupObj,
    }).catch(() => { });
  }
}

/**
 * Kirim sample preview images sebagai mediaGroup (3-10 foto sampel dari gallery post).
 */
async function doCptPreview(bot, chatId, cacheIndex) {
  const cache = browseCache.get(chatId);
  const detail = cache?.detailCache?.[cacheIndex];
  if (!detail || !detail.previewImages || detail.previewImages.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Preview tidak tersedia. Klik Detail ulang.');
  }

  const loadMsg = await bot.sendMessage(chatId, `👀 <b>Mengirim ${Math.min(detail.previewImages.length, 10)} sample foto...</b>`, { parse_mode: 'HTML' });

  try {
    const sampleUrls = detail.previewImages.slice(0, 10);
    const mediaGroup = sampleUrls.map((url, i) => ({
      type: 'photo',
      media: url,
      caption: i === 0 ? `👀 Preview sample dari ${escHtml((detail.meta?.character || detail.title || 'Post').slice(0, 80))}` : undefined,
      parse_mode: 'HTML',
    }));

    await bot.sendMediaGroup(chatId, mediaGroup);
    bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
  } catch (e) {
    log.warn(`[Cosplaytele] Preview gagal: ${e.message}`);
    bot.editMessageText(`⚠️ Gagal kirim preview: ${e.message.slice(0, 120)}`, {
      chat_id: chatId, message_id: loadMsg.message_id,
    }).catch(() => { });
  }
}

/**
 * Cosplaytele Gacha dengan multi-mode pool.
 * Modes:
 *   'random'    → random page 1-50 dari home (default, luas)
 *   'trending24'→ /24-hours/ (60 trending hari ini)
 *   'trending3d'→ /3-day/
 *   'trending7d'→ /7-day/
 *   'ero'       → random dari category cosplay-ero
 *   'nude'      → random dari category nude
 *   'video'     → random dari category video
 */
async function doCosplayteleGacha(bot, chatId, mode = 'random') {
  log.info(`[User ${chatId}] Cosplaytele gacha mode=${mode}`);

  const modeLabel = {
    random: '🎲 Random',
    trending24: '🔥 Trending 24j',
    trending3d: '🔥 Trending 3d',
    trending7d: '🔥 Trending 7d',
    ero: '💋 Ero',
    nude: '🔞 Nude',
    video: '🎬 Video',
  }[mode] || '🎲 Random';

  const gMsg = await bot.sendMessage(chatId,
    `🎲 <b>Cosplay Gacha ${modeLabel}...</b>\n<i>Mengacak album cosplay...</i>`,
    { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, gMsg.message_id);
  statsDb.addGacha(chatId);

  try {
    let posts = [];
    let contextInfo = '';

    if (mode.startsWith('trending')) {
      const windowKey = mode === 'trending24' ? '24-hours' : mode === 'trending3d' ? '3-day' : '7-day';
      posts = await cosplayteleScraper.scrapeTrending(windowKey);
      contextInfo = windowKey;
    } else if (mode === 'ero') {
      const randPage = Math.floor(Math.random() * 20) + 1;
      posts = await cosplayteleScraper.scrapeCategory('cosplay-ero', randPage);
      contextInfo = `ero page ${randPage}`;
    } else if (mode === 'nude') {
      const randPage = Math.floor(Math.random() * 20) + 1;
      posts = await cosplayteleScraper.scrapeCategory('nude', randPage);
      contextInfo = `nude page ${randPage}`;
    } else if (mode === 'video') {
      const randPage = Math.floor(Math.random() * 10) + 1;
      posts = await cosplayteleScraper.scrapeCategory('video-cosplayy', randPage);
      contextInfo = `video page ${randPage}`;
    } else {
      // Default random
      const randPage = Math.floor(Math.random() * 50) + 1;
      posts = await cosplayteleScraper.scrapeListing(randPage, 'home');
      contextInfo = `page ${randPage}`;
    }

    if (!posts || posts.length === 0) {
      return bot.editMessageText('❌ Pool gacha kosong. Coba mode lain.', {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎲 Reroll', callback_data: `cptgacha_${mode}` },
            { text: '🔙 Menu', callback_data: 'menu_awal' },
          ]],
        },
      });
    }

    // Anti-repeat
    const unseen = posts.filter(p => !historyTracker.hasSeen(chatId, 'cosplay', p.url));
    const pick = unseen.length > 0
      ? unseen[Math.floor(Math.random() * unseen.length)]
      : posts[Math.floor(Math.random() * posts.length)];
    historyTracker.markSeen(chatId, 'cosplay', pick.url);

    log.ok(`[Cpt-Gacha] mode=${mode} pool=${posts.length} unseen=${unseen.length} pick="${(pick.title || '?').slice(0, 60)}"`);

    // Simpan sbg pseudo-listing 1-item, flag isGacha agar back button balik ke menu gacha
    browseCache.set(chatId, {
      posts: [pick], page: 1, category: 'home', query: null,
      mode: 'gacha', isGacha: true, gachaMode: mode,
    });

    // Announcement dengan header dramatis
    await bot.editMessageText(
      `🎰 <b>SSR Acquired!</b>\n\n` +
      (pick.character ? `✨ <b>${escHtml(pick.character)}</b>` : '') +
      (pick.series ? ` · <i>${escHtml(pick.series)}</i>` : '') +
      (pick.cosplayer ? `\n👤 ${escHtml(pick.cosplayer)}` : '') +
      (pick.photoCount ? `\n📸 ${pick.photoCount}${pick.videoCount ? ` +${pick.videoCount}🎬` : ''}` : '') +
      `\n\n<i>Mode: ${modeLabel} · ${contextInfo}</i>\n\n` +
      `⏳ <i>Memuat link download...</i>`,
      { chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML' }
    );

    await sendPostDetail(bot, chatId, gMsg, pick, 0);
  } catch (e) {
    log.error(`[Cpt-Gacha] ${e.message}`);
    bot.editMessageText(`❌ Error Gacha: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

async function doKemonoGacha(bot, chatId, creatorUrl) {
  const gMsg = await bot.sendMessage(chatId, '🍁 <b>Patreon Gacha...</b>\n<i>Menelusuri database Patreon dari vault...</i>', { parse_mode: 'HTML' });
  statsDb.addGacha(chatId);

  // Eksekusi pembersihan media gacha lama
  const oldMsgs = kemonoTracker.get(chatId) || [];
  if (oldMsgs.length > 0) {
    for (const mId of oldMsgs) {
      bot.deleteMessage(chatId, mId).catch(() => { });
      await sleep(35); // cegah error socket
    }
    kemonoTracker.set(chatId, []);
  }

  try {
    const selectedPost = await kemonoScraper.getRandomKemonoPost(creatorUrl, chatId);
    const mediaUrls = await kemonoScraper.getKemonoPostMedia(selectedPost.href);
    const rawUrls = [...mediaUrls.inlineImgs, ...mediaUrls.links]
      .filter(u => u.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/)); // Support images & videos
    const allUrls = [...new Set(rawUrls)]; // Remove duplicate urls

    if (allUrls.length === 0) {
      return bot.editMessageText(`😔 <b>${selectedPost.title}</b>\n\nPost ini tidak berisi gambar yang didukung (mungkin isinya zip/teks saja). Coba gacha lagi!`, {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_kemono_reroll' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    await bot.editMessageText(`🍁 <b>${selectedPost.title}</b>\n\n<i>⏳ Target Cloudflare terkunci. Mengekstrak ${allUrls.length} media secara luring ke server lokal...</i>`, {
      chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML'
    }).catch(() => { });

    // Bikin direktori luring
    const jobDir = path.join(CONFIG.TEMP_DIR, 'kemono_' + Date.now());
    await fsp.mkdir(jobDir, { recursive: true });

    let downloadedFiles = [];
    for (let i = 0; i < allUrls.length; i++) {
      const u = allUrls[i];
      try {
        const cleanUrl = u.split('?')[0];
        let ext = path.extname(cleanUrl) || '.jpg';
        if (!ext.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i)) ext = '.jpg'; // Fallback
        const dest = path.join(jobDir, `media_${i}${ext}`);

        // Mengunduh diam-diam + validasi content-type agar HTML error tidak tersimpan sbg .jpg
        await downloadStream(u, dest, null, null, { expectMedia: true });
        downloadedFiles.push(dest);
      } catch (e) {
        log.warn(`[Kemono DL] Gagal download ${u}`);
      }
    }

    if (downloadedFiles.length === 0) {
      await rimraf(jobDir);
      return bot.editMessageText(`❌ Gagal mendownload isi media (Akses ditolak CDN/Kosong)`, { chat_id: chatId, message_id: gMsg.message_id });
    }

    await bot.editMessageText(`🍁 <b>${selectedPost.title}</b>\n\n<i>✓ Berhasil mendownload ${downloadedFiles.length} media. Memfilter ukuran raksasa...</i>`, { chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML' }).catch(() => { });

    // Filter kompresor untuk memangkas ukuran raksasa melebihi 10MB
    await sanitizeMediasForTelegram(downloadedFiles, (txt) => {
      bot.editMessageText(txt, { chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML' }).catch(() => { });
    });

    // Filter pelindung API Telegram limit (50MB Cloud / 2000MB Lokal)
    const validFiles = downloadedFiles.filter(f => {
      if (!fs.existsSync(f)) return false;
      return fs.statSync(f).size <= CONFIG.VIDEO_MAX_BYTES;
    });
    const rejectedCount = downloadedFiles.length - validFiles.length;

    // Hapus pesan progres
    bot.deleteMessage(chatId, gMsg.message_id).catch(() => { });

    const thresholdMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024);
    if (validFiles.length === 0) {
      await rimraf(jobDir);
      return bot.sendMessage(chatId, `😔 Seluruh file di post ini terlalu raksasa (>${thresholdMB}MB) yang ditolak mutlak oleh Server Telegram Anda.\n\nSilakan coba post lain.`, { reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_kemono_reroll' }]] } });
    }

    const chunks = chunkMediaByLimits(validFiles);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const mediaGroup = chunk.map((localFile, idx) => ({
        type: localFile.match(/\.(mp4|mov|webm)$/i) ? 'video' : 'photo',
        media: fs.createReadStream(localFile),
        // Telegram tidak mengizinkan tombol (reply_markup) pada Album (MediaGroup). 
        // Caption dikosongkan agar semua teks digabung pada menu kemudi di bawahnya.
        parse_mode: 'HTML'
      }));

      try {
        const resGroups = await bot.sendMediaGroup(chatId, mediaGroup);
        // Rekam message_id setiap foto yang tayang agar bisa dihapus pada reroll berikutnya
        const tracked = kemonoTracker.get(chatId) || [];
        resGroups.forEach(m => tracked.push(m.message_id));
        kemonoTracker.set(chatId, tracked);
      } catch (e) {
        log.error(`[Patreon Batch Send Error] ${e.message}`);
      }
      await sleep(CONFIG.SEND_DELAY);
    }

    let navText = `🍁 <b>${selectedPost.title}</b>\n\n✨ <i>Selesai! ${validFiles.length} File premium berhasil dikirim.</i>`;
    if (rejectedCount > 0) navText += `\n⚠️ <i>${rejectedCount} video dilewati karena melebihi kapasitas server Telegram Anda!</i>`;

    const navMsg = await bot.sendMessage(chatId, navText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll Gacha', callback_data: 'menu_kemono_reroll' }, { text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
    });
    autoCleanOldMenu(bot, chatId, navMsg.message_id);

    // Bersihkan jejak
    await rimraf(jobDir);

  } catch (e) {
    log.error('Patreon Gacha gagal: ' + e.message);
    bot.editMessageText(`❌ Error Patreon: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

// ─── RULE34VIDEO HANDLERS ────────────────────────────────────────────────────
async function doR34Browse(bot, chatId, page = 1, query = null) {
  log.info(`[User ${chatId}] Request R34Video (Page: ${page}, Query: ${query || 'none'})`);
  const loadMsg = await bot.sendMessage(chatId, `🎬 <b>Memuat Rule34Video...</b>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    const posts = await r34Scraper.scrapeListing(page, query);
    if (!posts.length) return bot.editMessageText('⚠️ Tidak ada video ditemukan.', { chat_id: chatId, message_id: loadMsg.message_id });

    const shown = posts.slice(0, 10);
    r34BrowseCache.set(chatId, { posts: shown, page, query });

    let text = `🎬 <b>Rule34Video</b> ${query ? `(Search: ${query})` : '(Terbaru)'} · Halaman ${page}\n\n`;
    shown.forEach((p, i) => text += `${i + 1}. ${escHtml(p.title)}\n`);

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 🎬 Detail`, callback_data: `r34_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 🎬 Detail`, callback_data: `r34_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `r34page_${page - 1}` });
    navRow.push({ text: 'Next ▶', callback_data: `r34page_${page + 1}` });
    buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

async function doR34Gacha(bot, chatId) {
  const gMsg = await bot.sendMessage(chatId, '🎬 <b>R34 Video Gacha...</b>\n<i>Mengacak konten dari database Rule34Video...</i>', { parse_mode: 'HTML' });
  statsDb.addGacha(chatId);

  try {
    // Ambil halaman random (1-100)
    const randomPage = Math.floor(Math.random() * 50) + 1;
    const posts = await r34Scraper.scrapeListing(randomPage);
    if (!posts.length) {
      return bot.editMessageText('😔 Gagal memuat video acak. Coba lagi!', {
        chat_id: chatId, message_id: gMsg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    const unseenPosts = posts.filter(p => !historyTracker.hasSeen(chatId, 'r34', p.link));
    const pick = unseenPosts.length > 0
      ? unseenPosts[Math.floor(Math.random() * unseenPosts.length)]
      : posts[Math.floor(Math.random() * posts.length)];

    historyTracker.markSeen(chatId, 'r34', pick.link);
    log.ok(`[R34] Gacha pick: ${pick.title}`);

    const links = await r34Scraper.scrapePostDetail(pick.link);
    if (!links.length) {
      return bot.editMessageText(`😔 <b>${escHtml(pick.title)}</b>\n\nGagal mendapatkan link download. Coba reroll!`, {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    await bot.editMessageText(`🎬 <b>${escHtml(pick.title)}</b>\n\n<i>⏳ Mengunduh video ke server lokal (auto-fallback resolusi)...</i>`, {
      chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML'
    }).catch(() => { });

    // Download resolusi tertinggi yang tersedia
    const jobDir = path.join(CONFIG.TEMP_DIR, 'r34_' + Date.now());
    await fsp.mkdir(jobDir, { recursive: true });
    let downloaded = null;
    let dlLabel = '';

    for (const dl of links) {
      try {
        const dest = path.join(jobDir, 'video.mp4');
        await downloadStream(dl.url, dest, null, null);
        downloaded = dest;
        dlLabel = dl.label;
        log.ok(`[R34] Berhasil download ${dl.label} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
        break;
      } catch (e) {
        log.warn(`[R34] Gagal download ${dl.label}: ${e.message}`);
      }
    }

    if (!downloaded) {
      await rimraf(jobDir);
      return bot.editMessageText(`❌ Semua resolusi gagal didownload.`, {
        chat_id: chatId, message_id: gMsg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    const fsize = fs.statSync(downloaded).size;
    const sizeMB = (fsize / 1024 / 1024).toFixed(1);

    // Hapus pesan loading
    bot.deleteMessage(chatId, gMsg.message_id).catch(() => { });

    // Kirim video
    try {
      await bot.sendVideo(chatId, fs.createReadStream(downloaded), {
        caption: `🎬 <b>${escHtml(pick.title)}</b> (${dlLabel}, ${sizeMB}MB)`,
        parse_mode: 'HTML', supports_streaming: true
      });
    } catch (e) {
      log.error(`[R34 Send Error] ${e.message}`);
    }

    const navMsg = await bot.sendMessage(chatId, `✨ <i>Video berhasil dikirim!</i>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll Gacha', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
    });
    autoCleanOldMenu(bot, chatId, navMsg.message_id);

    // Cleanup
    await rimraf(jobDir);
  } catch (e) {
    log.error('R34 Gacha gagal: ' + e.message);
    bot.editMessageText(`❌ Error R34: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

async function doR34PostDetail(bot, chatId, post) {
  const loadMsg = await bot.sendMessage(chatId, `🎬 <b>Memuat detail...</b>`, { parse_mode: 'HTML' });

  try {
    const links = await r34Scraper.scrapePostDetail(post.link);
    const idx = r34BrowseCache.get(chatId)?.posts?.indexOf(post) ?? 0;
    let text = `🎬 <b>${escHtml(post.title)}</b>\n\n`;

    const buttons = [];
    if (links.length) {
      text += `📥 <b>Pilih Resolusi Download:</b>\n`;
      links.forEach((l, i) => {
        text += `• ${l.label}\n`;
        buttons.push([{ text: `⬇️ ${l.label}`, callback_data: `r34dlres_${idx}_${i}` }]);
      });
    } else {
      text += '⚠️ Tidak ada link download terdeteksi.';
    }

    buttons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'r34_back_browse' }]);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    if (post.thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      await bot.sendPhoto(chatId, post.thumb, {
        caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons }
      });
    } else {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      });
    }
  } catch (e) {
    bot.editMessageText(`❌ Gagal: ${e.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

// ─── PINTEREST SEARCH HANDLERS ───────────────────────────────────────────────
/**
 * Search Pinterest + tampilkan listing. `bookmark` = null untuk page pertama.
 * prevBookmarks di cache untuk support navigasi "Prev" (Pinterest bookmark one-way,
 * jadi kita track history bookmark-bookmark sebelumnya).
 */
async function doPinSearch(bot, chatId, query, bookmark = null) {
  log.info(`[User ${chatId}] Request Pinterest search: "${query}" bookmark=${bookmark ? bookmark.slice(0, 20) + '...' : 'first'}`);
  const loadMsg = await bot.sendMessage(chatId, `📌 <b>Memuat Pinterest...</b>\n<i>Query: ${escHtml(query)}</i>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    const { pins, nextBookmark } = await pinterestScraper.scrapeSearch(query, bookmark);
    if (!pins.length) {
      return bot.editMessageText(`⚠️ Tidak ada pin ditemukan untuk <b>${escHtml(query)}</b>.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
      });
    }

    // Tampilkan 8 pin per page
    const shown = pins.slice(0, 8);
    const prev = pinBrowseCache.get(chatId);
    const prevBookmarks = prev?.query === query ? (prev.prevBookmarks || []) : [];
    // Kalau ini bukan first page, simpan bookmark sekarang supaya bisa Prev
    if (bookmark && !prevBookmarks.includes(bookmark)) prevBookmarks.push(bookmark);

    pinBrowseCache.set(chatId, {
      pins: shown,
      query,
      currentBookmark: bookmark,
      nextBookmark,
      prevBookmarks,
    });

    let text = `📌 <b>Pinterest:</b> <i>${escHtml(query)}</i>\n\n`;
    shown.forEach((p, i) => {
      const icon = p.type === 'video' ? '🎬' : '🖼️';
      text += `${i + 1}. ${icon} ${escHtml(p.title.slice(0, 70))}\n`;
    });
    text += `\n<i>${pins.length} hasil di halaman ini</i>`;

    // Tombol "Kirim" per pin, 2 per baris
    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. ${shown[i].type === 'video' ? '🎬' : '🖼️'} Kirim`, callback_data: `pin_dl_${i}` }];
      if (i + 1 < shown.length) {
        row.push({ text: `${i + 2}. ${shown[i + 1].type === 'video' ? '🎬' : '🖼️'} Kirim`, callback_data: `pin_dl_${i + 1}` });
      }
      buttons.push(row);
    }

    // Navigasi halaman
    const navRow = [];
    if (prevBookmarks.length > 0) navRow.push({ text: '◀ Prev', callback_data: 'pin_prev' });
    if (nextBookmark) navRow.push({ text: 'Next ▶', callback_data: 'pin_next' });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    log.error(`[Pinterest] doPinSearch error: ${err.message}`);
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

/**
 * Kirim satu pin (image/video) ke chat. Image langsung pakai URL (Telegram download sendiri),
 * video di-download ke disk dulu lalu streaming upload agar reliable di VPS.
 */
async function doPinSendItem(bot, chatId, pin) {
  const loadMsg = await bot.sendMessage(chatId, `📌 <b>Mengirim...</b>`, { parse_mode: 'HTML' });

  try {
    statsDb.addGacha(chatId);
    const caption = escHtml(pin.title.slice(0, 900));

    if (pin.type === 'image') {
      // Telegram bisa fetch URL image langsung — lebih cepat daripada download dulu
      try {
        await bot.sendPhoto(chatId, pin.imageUrl, {
          caption: `📌 <b>${caption}</b>\n<a href="${pin.pinUrl}">Buka di Pinterest</a>`,
          parse_mode: 'HTML',
        });
        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
        return;
      } catch (e) {
        log.warn(`[Pinterest] sendPhoto URL gagal (${e.message}), fallback download...`);
        // Fallback: download + sendPhoto dari stream. Image biasanya < 5MB.
        const jobDir = path.join(CONFIG.TEMP_DIR, 'pin_' + Date.now());
        await fsp.mkdir(jobDir, { recursive: true });
        const ext = path.extname(pin.imageUrl.split('?')[0]) || '.jpg';
        const dest = path.join(jobDir, `pin_${pin.id}${ext}`);
        await downloadStream(pin.imageUrl, dest, null, null, { expectMedia: true });
        const sz = fs.statSync(dest).size;
        statsDb.addDownloadSize(chatId, sz);
        try {
          await bot.sendPhoto(chatId, fs.createReadStream(dest), {
            caption: `📌 <b>${caption}</b>\n<a href="${pin.pinUrl}">Buka di Pinterest</a>`,
            parse_mode: 'HTML',
          });
        } catch (e2) {
          await bot.sendDocument(chatId, fs.createReadStream(dest), {
            caption: `📌 <b>${caption}</b>`, parse_mode: 'HTML',
          });
        }
        await rimraf(jobDir);
      }
    } else if (pin.type === 'video') {
      // Video harus di-download dulu karena Telegram sendVideo by URL sering gagal untuk
      // domain yang tidak whitelisted mereka.
      const jobDir = path.join(CONFIG.TEMP_DIR, 'pin_' + Date.now());
      await fsp.mkdir(jobDir, { recursive: true });
      const dest = path.join(jobDir, `pin_${pin.id}.mp4`);

      await bot.editMessageText(`📌 <b>Mengunduh video...</b>`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });

      await downloadStream(pin.videoUrl, dest, null, null, { expectMedia: true });
      const sz = fs.statSync(dest).size;
      statsDb.addDownloadSize(chatId, sz);

      if (sz > CONFIG.VIDEO_MAX_BYTES) {
        await rimraf(jobDir);
        const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024);
        return bot.editMessageText(
          `⚠️ Video ${(sz / 1048576).toFixed(1)}MB melebihi limit ${limitMB}MB.\n` +
          `<a href="${pin.pinUrl}">Buka di Pinterest</a>`,
          { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' }
        );
      }

      try {
        await bot.sendVideo(chatId, fs.createReadStream(dest), {
          caption: `📌 <b>${caption}</b>\n<a href="${pin.pinUrl}">Buka di Pinterest</a>`,
          parse_mode: 'HTML',
          supports_streaming: true,
        });
        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      } catch (e) {
        log.warn(`[Pinterest] sendVideo gagal (${e.message}), fallback doc`);
        await bot.sendDocument(chatId, fs.createReadStream(dest), { caption });
      }
      await rimraf(jobDir);
    }
  } catch (e) {
    log.error(`[Pinterest] send error: ${e.message}`);
    bot.editMessageText(`❌ Gagal kirim: <code>${escHtml(e.message.slice(0, 200))}</code>`, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
    }).catch(() => { });
  }
}

// ─── JAVTIFUL HELPERS ────────────────────────────────────────────────────────

/**
 * Normalisasi input user: `mide232` / `mide 232` → `MIDE-232`.
 * Kalau bukan kode JAV, kembalikan apa adanya (trimmed).
 */
function normalizeJavQuery(q) {
  const trimmed = String(q || '').trim();
  if (!trimmed) return trimmed;
  // Pattern: 2-6 huruf + (optional dash/space) + 2-5 digit
  const m = trimmed.match(/^([a-zA-Z]{2,6})[\s-]?(\d{2,5})$/);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return trimmed;
}

function formatViews(n) {
  if (!n || n < 0) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'K';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function formatRelativeDate(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'hari ini';
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} hari lalu`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / (7 * day))} minggu lalu`;
  if (diffMs < 365 * day) return `${Math.floor(diffMs / (30 * day))} bulan lalu`;
  return `${Math.floor(diffMs / (365 * day))} tahun lalu`;
}

// ─── JAVTIFUL HANDLERS ───────────────────────────────────────────────────────
/**
 * Unified browse handler: support mode 'search' | 'actress' | 'category'.
 * Kalau mode='search', query = search term.
 * Kalau mode='actress'|'category', query = slug (contoh 'matsumoto-nanami' / 'big-tits').
 * contextLabel dipakai untuk heading (nama aktris/kategori humanized).
 */
async function doJavBrowse(bot, chatId, query, page = 1, mode = 'search', contextLabel = null) {
  const normalized = mode === 'search' ? normalizeJavQuery(query) : query;
  log.info(`[User ${chatId}] Javtiful ${mode} "${normalized}" page=${page}`);

  const headerEmoji = mode === 'actress' ? '👤' : mode === 'category' ? '🏷️' : '🎥';
  const headerLabel = mode === 'actress' ? 'Aktris' : mode === 'category' ? 'Kategori' : 'Javtiful';
  const displayQuery = contextLabel || normalized;

  const loadMsg = await bot.sendMessage(chatId, `${headerEmoji} <b>Memuat ${headerLabel}...</b>\n<i>${escHtml(displayQuery)}</i>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    let result;
    if (mode === 'actress') result = await javtifulScraper.scrapeActress(normalized, page);
    else if (mode === 'category') result = await javtifulScraper.scrapeCategory(normalized, page);
    else result = await javtifulScraper.scrapeSearch(normalized, page);

    const { items, pagination } = result;
    if (!items.length) {
      // Suggest format koreksi kalau mode search & input kayak kode JAV mentah
      let hint = '';
      if (mode === 'search' && normalized !== query) {
        hint = `\n<i>💡 Tip: normalisasi ke <code>${escHtml(normalized)}</code> — coba juga kata kunci lain.</i>`;
      }
      return bot.editMessageText(`⚠️ Tidak ada video ditemukan untuk <b>${escHtml(displayQuery)}</b>.${hint}`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
      });
    }

    const shown = items.slice(0, 8);
    javBrowseCache.set(chatId, {
      items: shown, query: normalized, page, hasNext: pagination.hasNext, mode, contextLabel,
    });

    let text = `${headerEmoji} <b>${headerLabel}:</b> <i>${escHtml(displayQuery)}</i> · Halaman ${page}\n\n`;
    shown.forEach((v, i) => {
      const parts = [];
      if (v.javCode) parts.push(`<code>${v.javCode}</code>`);
      if (v.durationText) parts.push(`⏱️ ${v.durationText}`);
      const meta = parts.length ? ' · ' + parts.join(' · ') : '';
      text += `${i + 1}. ${escHtml(v.title.slice(0, 70))}${meta}\n`;
    });

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 🎥 Detail`, callback_data: `jav_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 🎥 Detail`, callback_data: `jav_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `javpage_${page - 1}` });
    if (pagination.hasNext) navRow.push({ text: 'Next ▶', callback_data: `javpage_${page + 1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (err) {
    log.error(`[Javtiful] browse error: ${err.message}`);
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

async function doJavDetail(bot, chatId, item) {
  const loadMsg = await bot.sendMessage(chatId, `🎥 <b>Memuat detail...</b>`, { parse_mode: 'HTML' });

  try {
    const detail = await javtifulScraper.scrapeDetail(item.link);
    if (!detail) {
      return bot.editMessageText(`⚠️ Gagal memuat halaman detail.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'jav_back_browse' }]] }
      });
    }
    if (!detail.sources.length) {
      return bot.editMessageText(`⚠️ Tidak ada source video yang dapat diekstrak.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'jav_back_browse' }]] }
      });
    }

    // Probe size parallel (hemat ~1 detik total latency)
    const primarySize = await javtifulScraper.probeSourceSize(detail.sources[0].url);
    const sizeMB = primarySize ? (primarySize / 1048576).toFixed(0) : null;
    const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1048576);

    const idx = javBrowseCache.get(chatId)?.items?.indexOf(item) ?? 0;

    // Build caption informatif
    let text = `🎥 <b>${escHtml(detail.title)}</b>\n\n`;
    if (detail.javCode) text += `🆔 <code>${detail.javCode.full}</code>\n`;
    const metaLine = [];
    if (detail.durationText) metaLine.push(`⏱️ ${detail.durationText}`);
    if (sizeMB) metaLine.push(`📦 ${sizeMB} MB`);
    if (detail.viewCount != null) metaLine.push(`👁️ ${formatViews(detail.viewCount)}`);
    if (detail.uploadDate) {
      const rel = formatRelativeDate(detail.uploadDate);
      if (rel) metaLine.push(`📅 ${rel}`);
    }
    if (metaLine.length) text += metaLine.join(' · ') + '\n';

    if (detail.actresses.length > 0) {
      text += `� ${detail.actresses.map(a => escHtml(a.name)).join(', ')}\n`;
    }
    if (detail.categories.length > 0) {
      text += `🏷️ ${detail.categories.slice(0, 4).map(c => escHtml(c.name)).join(' · ')}\n`;
    }
    text += `\n🔗 <a href="${item.link}">Halaman Javtiful</a>`;

    const buttons = [];

    // Download button
    if (sizeMB && primarySize > CONFIG.VIDEO_MAX_BYTES) {
      text += `\n\n⚠️ <b>Melebihi limit upload ${limitMB} MB.</b> Tidak bisa di-stream ke Telegram.\nDownload manual via link halaman di atas.`;
    } else {
      const primaryBtn = { text: `⬇️ Download ${detail.sources[0].label}${sizeMB ? ` (${sizeMB} MB)` : ''}`, callback_data: `javdl_${idx}_0` };
      buttons.push([primaryBtn]);
      // Kalau ada multi-resolution (beberapa post JAV kadang 1080+720+480), tampilkan sebagai opsi
      if (detail.sources.length > 1) {
        const altRow = [];
        detail.sources.slice(1).forEach((s, i) => {
          altRow.push({ text: `⬇️ ${s.label}`, callback_data: `javdl_${idx}_${i + 1}` });
        });
        if (altRow.length > 0) buttons.push(altRow);
      }
    }

    // Explore: actress button (max 2 untuk hemat space)
    if (detail.actresses.length > 0) {
      const actRow = detail.actresses.slice(0, 2).map(a =>
        ({ text: `👤 ${a.name.slice(0, 20)}`, callback_data: `javact_${a.slug}` })
      );
      buttons.push(actRow);
    }

    // Explore: category button (max 3)
    if (detail.categories.length > 0) {
      const catRow = detail.categories.slice(0, 3).map(c =>
        ({ text: `🏷️ ${c.name.slice(0, 18)}`, callback_data: `javcat_${c.slug}` })
      );
      buttons.push(catRow);
    }

    // Explore: related videos
    if (detail.related.length > 0) {
      buttons.push([{ text: `🔗 Video Mirip (${detail.related.length})`, callback_data: `javrel_${idx}` }]);
    }

    buttons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'jav_back_browse' }]);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    // Kirim preview dengan thumbnail
    if (detail.thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      try {
        await bot.sendPhoto(chatId, detail.thumb, {
          caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
        });
      } catch (e) {
        await bot.sendMessage(chatId, text, {
          parse_mode: 'HTML', disable_web_page_preview: false,
          reply_markup: { inline_keyboard: buttons },
        });
      }
    } else {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    }

    // Cache detail (termasuk related) supaya callback javrel_/javdl_ pakai tanpa re-fetch
    const cache = javBrowseCache.get(chatId) || { items: [], query: '', page: 1 };
    cache.detailCache = cache.detailCache || {};
    cache.detailCache[item.id] = detail;
    javBrowseCache.set(chatId, cache);
  } catch (e) {
    log.error(`[Javtiful] detail error: ${e.message}`);
    bot.editMessageText(`❌ Gagal: ${e.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

/**
 * Tampilkan daftar "Video Mirip" (related) dari detail yang sudah di-cache.
 */
async function doJavShowRelated(bot, chatId, item) {
  const cache = javBrowseCache.get(chatId);
  const detail = cache?.detailCache?.[item.id];
  if (!detail || !detail.related.length) {
    return bot.sendMessage(chatId, '⚠️ Related videos tidak tersedia. Buka detail ulang.');
  }

  // Shown max 8 related untuk kompatibilitas UI
  const shown = detail.related.slice(0, 8);
  // Simpan ke cache sebagai "pseudo listing" supaya callback jav_<idx> jalan
  javBrowseCache.set(chatId, {
    items: shown,
    query: `related:${item.id}`,
    page: 1,
    hasNext: false,
    mode: 'related',
    contextLabel: `Mirip: ${item.title.slice(0, 40)}`,
    detailCache: cache.detailCache,
    fromRelated: { originalItem: item },
  });

  let text = `🔗 <b>Video Mirip:</b>\n<i>Dari ${escHtml(item.title.slice(0, 60))}</i>\n\n`;
  shown.forEach((v, i) => {
    const dur = v.durationText ? ` · ⏱️ ${v.durationText}` : '';
    text += `${i + 1}. ${escHtml(v.title.slice(0, 70))}${dur}\n`;
  });

  const buttons = [];
  for (let i = 0; i < shown.length; i += 2) {
    const row = [{ text: `${i + 1}. 🎥 Detail`, callback_data: `jav_${i}` }];
    if (i + 1 < shown.length) row.push({ text: `${i + 2}. 🎥 Detail`, callback_data: `jav_${i + 1}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * Javtiful Gacha — pilih 1 video acak dari trending/latest pool.
 * Anti-repeat: cek history.js (category 'jav') supaya user gak dapat video sama berulang.
 * Mode:
 *   'trending' → pool 23 video trending daily
 *   'latest'   → pool 46K+ video dari /videos paginated (default, lebih surprise)
 *   'cosplay'  → shortcut /category/cosplay (niche gacha)
 */
async function doJavGacha(bot, chatId, mode = 'latest') {
  log.info(`[User ${chatId}] /jav gacha mode=${mode}`);

  const gMsg = await bot.sendMessage(chatId,
    `🎲 <b>JAV Gacha ${mode === 'trending' ? '🔥 Trending' : mode === 'cosplay' ? '👘 Cosplay' : '🎰 Random'}...</b>\n` +
    `<i>Mengacak dari ribuan video...</i>`,
    { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, gMsg.message_id);
  statsDb.addGacha(chatId);

  try {
    let pool = [];
    let randomPage = 1;

    if (mode === 'trending') {
      // Trending: 1 page aja (23 video fresh)
      const r = await javtifulScraper.scrapeTrending();
      pool = r.items;
    } else if (mode === 'cosplay') {
      // Cosplay category: pick random page dari ~100 pages yang valid
      randomPage = Math.floor(Math.random() * 50) + 1;
      const r = await javtifulScraper.scrapeCategory('cosplay', randomPage);
      pool = r.items;
    } else {
      // Latest /videos: ~2000 pages, jangkauan random lebar
      randomPage = Math.floor(Math.random() * 200) + 1; // 1-200 untuk video relatif recent
      const r = await javtifulScraper.scrapeLatest(randomPage);
      pool = r.items;
    }

    if (!pool.length) {
      return bot.editMessageText(`😔 Mesin gacha kosong. Coba lagi atau pilih mode lain.`, {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎲 Reroll', callback_data: `javgacha_${mode}` },
            { text: '🔙 Menu', callback_data: 'menu_awal' },
          ]]
        }
      });
    }

    // Anti-repeat via historyTracker (category 'jav')
    const unseen = pool.filter(v => !historyTracker.hasSeen(chatId, 'jav', v.link));
    const picked = unseen.length > 0
      ? unseen[Math.floor(Math.random() * unseen.length)]
      : pool[Math.floor(Math.random() * pool.length)];
    historyTracker.markSeen(chatId, 'jav', picked.link);

    log.ok(`[Jav-Gacha] pool=${pool.length} unseen=${unseen.length} pick="${picked.title.slice(0, 60)}" (page ${randomPage})`);

    // Simpan ke cache sbg pseudo listing 1-item supaya callback jav_0 jalan
    // fromGacha flag supaya Back di detail balik ke menu gacha bukan listing.
    javBrowseCache.set(chatId, {
      items: [picked],
      query: `gacha:${mode}`,
      page: 1,
      hasNext: false,
      mode: 'gacha',
      contextLabel: mode === 'trending' ? 'Gacha Trending' : mode === 'cosplay' ? 'Gacha Cosplay' : 'Gacha Random',
      fromGacha: { mode },
    });

    // Tampilkan pick dengan pengantar dramatis + langsung tombol Detail + Reroll
    const parts = [];
    if (picked.javCode) parts.push(`🆔 <code>${picked.javCode}</code>`);
    if (picked.durationText) parts.push(`⏱️ ${picked.durationText}`);
    const metaLine = parts.length ? '\n' + parts.join(' · ') : '';

    const text = `🎰 <b>JAV SSR Acquired!</b>\n\n` +
      `🎥 <b>${escHtml(picked.title.slice(0, 150))}</b>${metaLine}\n\n` +
      `<i>Mode: ${mode} · Page ${randomPage}</i>`;

    const buttons = [
      [{ text: '🎥 Lihat Detail + Download', callback_data: 'jav_0' }],
      [
        { text: '🎲 Reroll Random', callback_data: `javgacha_latest` },
        { text: '🔥 Reroll Trending', callback_data: `javgacha_trending` },
      ],
      [
        { text: '👘 Reroll Cosplay', callback_data: `javgacha_cosplay` },
        { text: '🔙 Menu Utama', callback_data: 'menu_awal' },
      ],
    ];

    // Kirim dengan thumbnail kalau ada — UX Gacha Cosplaytele style
    bot.deleteMessage(chatId, gMsg.message_id).catch(() => { });
    if (picked.thumb) {
      try {
        const sentMsg = await bot.sendPhoto(chatId, picked.thumb, {
          caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
        });
        autoCleanOldMenu(bot, chatId, sentMsg.message_id);
        return;
      } catch (e) {
        log.warn(`[Jav-Gacha] sendPhoto gagal (${e.message}), fallback text`);
      }
    }
    const sentMsg = await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
    });
    autoCleanOldMenu(bot, chatId, sentMsg.message_id);
  } catch (err) {
    log.error(`[Jav-Gacha] error: ${err.message}`);
    bot.editMessageText(`❌ Gacha gagal: ${err.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

async function doJavDownload(bot, chatId, item, sourceIdx = 0) {
  // Ambil detail dari cache kalau ada, re-scrape kalau expired
  const cache = javBrowseCache.get(chatId);
  let detail = cache?.detailCache?.[item.id];
  if (!detail) {
    detail = await javtifulScraper.scrapeDetail(item.link);
    if (!detail) {
      return bot.sendMessage(chatId, '❌ Gagal resolve video detail.');
    }
  }

  const source = detail.sources[sourceIdx] || detail.sources[0];
  if (!source) {
    return bot.sendMessage(chatId, '❌ Source video tidak tersedia.');
  }

  queueManager.addJob(chatId, `Javtiful: ${detail.title.slice(0, 40)}`, async (jobId) => {
    const jobDir = path.join(CONFIG.TEMP_DIR, 'jav_' + jobId);
    await fsp.mkdir(jobDir, { recursive: true });
    const dest = path.join(jobDir, `${item.id}_${source.label}.mp4`);

    const statusMsg = await bot.sendMessage(chatId, `🎥 <b>${escHtml(detail.title)}</b>\n<i>⏳ Memulai download ${source.label}...</i>`, { parse_mode: 'HTML' });
    const startedAt = Date.now();
    const throttle = createProgressThrottler(2500);

    try {
      await downloadStream(source.url, dest, (pct, dl, tot) => {
        throttle(() => {
          const pText = renderProgressBar({
            icon: '🎥',
            title: detail.title,
            done: dl, total: tot,
            unit: 'bytes',
            startedAt,
          });
          if (jobId) queueManager.updateJob(jobId, pText);
          bot.editMessageText(pText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => { });
        }, tot && dl === tot);
      }, null, { expectMedia: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' });

      const fsize = fs.statSync(dest).size;
      const sizeMB = (fsize / 1048576).toFixed(1);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      botStats.downloadedBytes += fsize;
      statsDb.addDownloadSize(chatId, fsize);
      log.ok(`[Javtiful] Download selesai: ${sizeMB} MB dalam ${elapsed}s`);

      if (fsize > CONFIG.VIDEO_MAX_BYTES) {
        await rimraf(jobDir);
        const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1048576);
        return bot.editMessageText(
          `⚠️ File <b>${sizeMB} MB</b> melebihi limit ${limitMB} MB Telegram.\n<a href="${item.link}">Buka halaman Javtiful</a>`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
        );
      }

      await bot.editMessageText(`📤 <b>${escHtml(detail.title.slice(0, 80))}</b>\n<i>⏳ Mengupload ${sizeMB} MB ke Telegram...</i>`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });

      try {
        await bot.sendVideo(chatId, fs.createReadStream(dest), {
          caption: `🎥 <b>${escHtml(detail.title)}</b> (${source.label}, ${sizeMB} MB)\n<a href="${item.link}">Source</a>`,
          parse_mode: 'HTML',
          supports_streaming: true,
        });
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      } catch (e) {
        log.warn(`[Javtiful] sendVideo gagal (${e.message}), fallback sendDocument`);
        await bot.sendDocument(chatId, fs.createReadStream(dest), {
          caption: `🎥 <b>${escHtml(detail.title)}</b> (${source.label}, ${sizeMB} MB)`,
          parse_mode: 'HTML',
        });
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      }
      await rimraf(jobDir);
    } catch (err) {
      log.error(`[Javtiful] download error: ${err.message}`);
      bot.editMessageText(`❌ Download gagal: <code>${escHtml(err.message.slice(0, 200))}</code>`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });
      await rimraf(jobDir);
    }
  }, bot);
}

// ─── EROTHOTS HANDLERS ───────────────────────────────────────────────────────
async function doEroBrowse(bot, chatId, query, page = 1) {
  log.info(`[User ${chatId}] Request EroThots search "${query}" page=${page}`);
  const loadMsg = await bot.sendMessage(chatId, `🔥 <b>Memuat EroThots...</b>\n<i>Query: ${escHtml(query)}</i>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    const { items, hasNext } = await erothotsScraper.scrapeSearch(query, page);
    if (!items.length) {
      return bot.editMessageText(`⚠️ Tidak ada video ditemukan untuk <b>${escHtml(query)}</b>.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
      });
    }

    const shown = items.slice(0, 8);
    eroBrowseCache.set(chatId, { items: shown, query, page, hasNext });

    let text = `🔥 <b>EroThots:</b> <i>${escHtml(query)}</i> · Halaman ${page}\n\n`;
    if (page > 1) text += `<i>⚠️ Catatan: page 2+ sering campur dengan video lain (bukan filter query).</i>\n\n`;
    shown.forEach((v, i) => {
      const dur = v.durationText ? ` · ⏱️ ${v.durationText}` : '';
      text += `${i + 1}. ${escHtml(v.title.slice(0, 75))}${dur}\n`;
    });

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 🎥 Detail`, callback_data: `ero_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 🎥 Detail`, callback_data: `ero_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `eropage_${page - 1}` });
    if (hasNext) navRow.push({ text: 'Next ▶', callback_data: `eropage_${page + 1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (err) {
    log.error(`[EroThots] browse error: ${err.message}`);
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

async function doEroDetail(bot, chatId, item) {
  const loadMsg = await bot.sendMessage(chatId, `🔥 <b>Memuat detail...</b>`, { parse_mode: 'HTML' });

  try {
    const detail = await erothotsScraper.scrapeDetail(item.link);
    if (!detail || !detail.videoUrl) {
      return bot.editMessageText(`⚠️ Tidak ada source video yang dapat diekstrak.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'ero_back_browse' }]] }
      });
    }

    const primarySize = await erothotsScraper.probeSourceSize(detail.videoUrl);
    const sizeMB = primarySize ? (primarySize / 1048576).toFixed(0) : null;
    const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1048576);

    const idx = eroBrowseCache.get(chatId)?.items?.indexOf(item) ?? 0;
    let text = `🔥 <b>${escHtml(detail.title)}</b>\n\n`;
    if (item.durationText) text += `⏱️ Durasi: ${item.durationText}\n`;
    if (sizeMB) text += `📦 Ukuran: ${sizeMB} MB\n`;
    text += `🔗 <a href="${item.link}">Halaman EroThots</a>\n\n`;

    const buttons = [];
    if (sizeMB && primarySize > CONFIG.VIDEO_MAX_BYTES) {
      text += `⚠️ <b>Melebihi limit upload ${limitMB} MB.</b> Tidak bisa di-stream ke Telegram.\n`;
      text += `Silakan download manual via link halaman di atas.`;
    } else {
      buttons.push([{ text: `⬇️ Download MP4${sizeMB ? ` (${sizeMB} MB)` : ''}`, callback_data: `erodl_${idx}` }]);
    }
    buttons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'ero_back_browse' }]);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    if (detail.thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      try {
        await bot.sendPhoto(chatId, detail.thumb, {
          caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
        });
      } catch (e) {
        await bot.sendMessage(chatId, text, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
        });
      }
    } else {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    }

    // Cache detail
    const cache = eroBrowseCache.get(chatId) || { items: [], query: '', page: 1 };
    cache.detailCache = cache.detailCache || {};
    cache.detailCache[item.id] = detail;
    eroBrowseCache.set(chatId, cache);
  } catch (e) {
    log.error(`[EroThots] detail error: ${e.message}`);
    bot.editMessageText(`❌ Gagal: ${e.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

async function doEroDownload(bot, chatId, item) {
  const cache = eroBrowseCache.get(chatId);
  let detail = cache?.detailCache?.[item.id];
  if (!detail) {
    detail = await erothotsScraper.scrapeDetail(item.link);
    if (!detail || !detail.videoUrl) {
      return bot.sendMessage(chatId, '❌ Gagal resolve video detail.');
    }
  }

  queueManager.addJob(chatId, `EroThots: ${detail.title.slice(0, 40)}`, async (jobId) => {
    const jobDir = path.join(CONFIG.TEMP_DIR, 'ero_' + jobId);
    await fsp.mkdir(jobDir, { recursive: true });
    const dest = path.join(jobDir, `${item.id}.mp4`);

    const statusMsg = await bot.sendMessage(chatId, `🔥 <b>${escHtml(detail.title)}</b>\n<i>⏳ Memulai download...</i>`, { parse_mode: 'HTML' });
    const startedAt = Date.now();
    const throttle = createProgressThrottler(2500);

    try {
      await downloadStream(detail.videoUrl, dest, (pct, dl, tot) => {
        throttle(() => {
          const pText = renderProgressBar({
            icon: '🔥',
            title: detail.title,
            done: dl, total: tot,
            unit: 'bytes',
            startedAt,
          });
          if (jobId) queueManager.updateJob(jobId, pText);
          bot.editMessageText(pText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => { });
        }, tot && dl === tot);
      }, null, { expectMedia: true });

      const fsize = fs.statSync(dest).size;
      const sizeMB = (fsize / 1048576).toFixed(1);
      botStats.downloadedBytes += fsize;
      statsDb.addDownloadSize(chatId, fsize);

      if (fsize > CONFIG.VIDEO_MAX_BYTES) {
        await rimraf(jobDir);
        const limitMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1048576);
        return bot.editMessageText(
          `⚠️ File <b>${sizeMB} MB</b> melebihi limit ${limitMB} MB Telegram.\n<a href="${item.link}">Buka halaman EroThots</a>`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
        );
      }

      await bot.editMessageText(`📤 <b>${escHtml(detail.title.slice(0, 80))}</b>\n<i>⏳ Mengupload ${sizeMB} MB...</i>`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });

      try {
        await bot.sendVideo(chatId, fs.createReadStream(dest), {
          caption: `🔥 <b>${escHtml(detail.title)}</b> (${sizeMB} MB)\n<a href="${item.link}">Source</a>`,
          parse_mode: 'HTML', supports_streaming: true,
        });
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      } catch (e) {
        log.warn(`[EroThots] sendVideo gagal, fallback sendDocument: ${e.message}`);
        await bot.sendDocument(chatId, fs.createReadStream(dest), {
          caption: `🔥 <b>${escHtml(detail.title)}</b>`, parse_mode: 'HTML',
        });
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      }
      await rimraf(jobDir);
    } catch (err) {
      log.error(`[EroThots] download error: ${err.message}`);
      bot.editMessageText(`❌ Download gagal: <code>${escHtml(err.message.slice(0, 200))}</code>`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });
      await rimraf(jobDir);
    }
  }, bot);
}

// ─── ANIME (Otakudesu + Oploverz) ───────────────────────────────────────────

/**
 * Search anime from both sources, merge results, show inline keyboard.
 */
async function doAnimeSearch(bot, chatId, query) {
  log.info(`[Anime] user ${chatId} search="${query}"`);
  const loadMsg = await bot.sendMessage(chatId, '🔍 <b>Mencari anime...</b>', { parse_mode: 'HTML' });

  try {
    const [otakuRes, oploRes] = await Promise.allSettled([
      otakudesuScraper.search(query),
      oploverzScraper.search(query),
    ]);

    const results = [];
    if (otakuRes.status === 'fulfilled') results.push(...otakuRes.value);
    if (oploRes.status === 'fulfilled') results.push(...oploRes.value);

    if (results.length === 0) {
      return bot.editMessageText('😕 Tidak ditemukan anime dengan judul tersebut.', {
        chat_id: chatId, message_id: loadMsg.message_id,
      });
    }

    // Dedupe by slug (prefer oploverz karena punya API rapi)
    const seen = new Set();
    const unique = [];
    for (const r of results) {
      const key = r.slug.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }

    // Cache results
    animeBrowseCache.set(chatId, { results: unique.slice(0, 20) });

    let text = `🎌 <b>Hasil Pencarian Anime</b>\n<i>"${escHtml(query)}"</i>\n\n`;
    const keyboard = [];
    unique.slice(0, 10).forEach((r, i) => {
      const srcTag = r.source === 'oploverz' ? '🅾' : '🅾‍';
      const statusTag = r.status === 'Ongoing' ? '🟢' : '✅';
      text += `${i + 1}. ${statusTag} <b>${escHtml(r.title)}</b>\n`;
      if (r.totalEpisodes) text += `   📺 ${r.totalEpisodes} eps`;
      if (r.genres?.length) text += ` • ${r.genres.slice(0, 3).join(', ')}`;
      text += `\n`;
      keyboard.push([{ text: `${i + 1}. ${r.title.slice(0, 45)}`, callback_data: `anm_sel_${i}` }]);
    });

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    log.error(`[Anime] search error: ${err.message}`);
    bot.editMessageText(`❌ Error: ${escHtml(err.message.slice(0, 200))}`, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
    }).catch(() => {});
  }
}

/**
 * Show episode list for selected anime.
 */
async function doAnimeEpisodes(bot, chatId, seriesIndex, page = 1) {
  const cache = animeBrowseCache.get(chatId);
  const series = cache?.results?.[seriesIndex];
  if (!series) return bot.sendMessage(chatId, '❌ Data anime tidak ditemukan, coba search ulang.');

  const loadMsg = await bot.sendMessage(chatId, `📺 <b>Memuat episode ${escHtml(series.title)}...</b>`, { parse_mode: 'HTML' });

  try {
    let episodes;
    if (series.source === 'oploverz') {
      episodes = await oploverzScraper.getEpisodes(series.slug);
      // Normalize to common format
      episodes = episodes.map(ep => ({
        number: parseInt(ep.episodeNumber),
        title: `Episode ${ep.episodeNumber}`,
        source: 'oploverz',
        _raw: ep,
      }));
    } else {
      // Otakudesu
      episodes = await otakudesuScraper.getEpisodes(series.url);
      episodes = episodes.map(ep => ({
        number: ep.number,
        title: ep.title || `Episode ${ep.number}`,
        url: ep.url,
        source: 'otakudesu',
      }));
    }

    if (episodes.length === 0) {
      return bot.editMessageText('😕 Belum ada episode tersedia.', {
        chat_id: chatId, message_id: loadMsg.message_id,
      });
    }

    // Cache episodes
    animeBrowseCache.set(chatId, { ...cache, episodes, seriesIdx: seriesIndex });

    // Paginate: 20 eps per page
    const perPage = 20;
    const totalPages = Math.ceil(episodes.length / perPage);
    const pageEps = episodes.slice((page - 1) * perPage, page * perPage);

    let text = `📺 <b>${escHtml(series.title)}</b>\n`;
    text += `Total: ${episodes.length} episode | Halaman ${page}/${totalPages}\n\n`;
    text += `Pilih episode untuk download:`;

    // Build keyboard: 4 columns
    const keyboard = [];
    let row = [];
    for (const ep of pageEps) {
      row.push({ text: `Ep ${ep.number}`, callback_data: `anm_ep_${ep.number}` });
      if (row.length === 4) { keyboard.push(row); row = []; }
    }
    if (row.length) keyboard.push(row);

    // Pagination buttons
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `anm_pg_${seriesIndex}_${page - 1}` });
    if (page < totalPages) navRow.push({ text: '➡️ Next', callback_data: `anm_pg_${seriesIndex}_${page + 1}` });
    if (navRow.length) keyboard.push(navRow);

    // Back button
    keyboard.push([{ text: '🔙 Kembali ke hasil', callback_data: 'anm_back_search' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    log.error(`[Anime] episodes error: ${err.message}`);
    bot.editMessageText(`❌ Error: ${escHtml(err.message.slice(0, 200))}`, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
    }).catch(() => {});
  }
}

/**
 * Show quality options for Oploverz episode, or start download for Otakudesu (Gofile).
 */
async function doAnimeDownload(bot, chatId, epNumber) {
  const cache = animeBrowseCache.get(chatId);
  const episodes = cache?.episodes;
  const series = cache?.results?.[cache?.seriesIdx];
  if (!episodes || !series) return bot.sendMessage(chatId, '❌ Data episode hilang, coba search ulang.');

  const ep = episodes.find(e => e.number === epNumber);
  if (!ep) return bot.sendMessage(chatId, `❌ Episode ${epNumber} tidak ditemukan.`);

  if (ep.source === 'otakudesu') {
    // Otakudesu: try to extract download links (Gofile + multi-host fallback)
    const loadMsg = await bot.sendMessage(chatId, `⏳ <b>Mengambil link download Ep ${epNumber}...</b>`, { parse_mode: 'HTML' });
    try {
      const dl = await otakudesuScraper.getEpisodeDownload(ep.url);
      if (dl.gofileUrl) {
        // Modern layout: single Gofile → use existing downloader
        await bot.editMessageText(`✅ Gofile ditemukan! Memulai download...\n<code>${escHtml(dl.gofileUrl)}</code>`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        });
        queueManager.addJob(chatId, `${series.title} Ep ${epNumber}`, async (jobId) => {
          await processDownload(bot, chatId, dl.gofileUrl, null, 'gofile', jobId);
        }, bot);
      } else if (dl.qualityLinks && dl.qualityLinks.length > 0) {
        // Classic layout (.blog): multi-host per quality.
        // ZippyShare mati, LetsUp/Racaty butuh CAPTCHA → fokus ke Mega (support megajs).
        // Cache quality links untuk callback (dengan epNumber supaya resolver tau episode mana).
        const qualityLinksWithEp = dl.qualityLinks.map(q => ({ ...q, epNumber }));
        animeBrowseCache.set(chatId, { ...cache, classicLinks: qualityLinksWithEp, lastEpNum: epNumber });

        let text = `📥 <b>${escHtml(series.title)} - Episode ${epNumber}</b>\n\n`;
        text += `Pilih kualitas untuk auto-download via Mega:\n`;

        const keyboard = [];
        dl.qualityLinks.forEach((q, qIdx) => {
          const megaLink = q.links.find(l => l.host.toLowerCase() === 'mega');
          if (megaLink) {
            keyboard.push([{
              text: `⬇️ ${q.quality} (Mega)`,
              callback_data: `anm_mega_${qIdx}`,
            }]);
          }
        });

        // Tambah link manual untuk host lain
        text += `\n<i>Link manual (untuk host selain Mega):</i>\n`;
        for (const q of dl.qualityLinks) {
          text += `<b>${escHtml(q.quality)}</b>: `;
          text += q.links.map(l => `<a href="${escHtml(l.url)}">${escHtml(l.host)}</a>`).join(' · ');
          text += `\n`;
        }

        keyboard.push([{ text: '🔙 Kembali', callback_data: `anm_pg_${cache?.seriesIdx ?? 0}_1` }]);

        await bot.editMessageText(text, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: keyboard },
        });
      } else {
        await bot.editMessageText(`😕 Tidak ada link download ditemukan untuk episode ini.\n\nLink lain yang terdeteksi:\n${dl.otherLinks.map(l => `• ${l.host}: ${l.url}`).join('\n') || 'Tidak ada'}`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ Error: ${escHtml(err.message.slice(0, 200))}`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      }).catch(() => {});
    }
  } else {
    // Oploverz: show quality picker
    const rawEp = ep._raw;
    const links = oploverzScraper.getAllLinks(rawEp);
    if (links.length === 0) return bot.sendMessage(chatId, '😕 Tidak ada link download tersedia.');

    // Cache for callback
    animeBrowseCache.set(chatId, { ...cache, oploLinks: links, oploEpNum: epNumber });

    let text = `📥 <b>${escHtml(series.title)} - Episode ${epNumber}</b>\n\nPilih kualitas:\n`;
    const keyboard = [];
    links.forEach((l, i) => {
      const label = `${l.format} ${l.quality} [${l.host}]`;
      text += `${i + 1}. ${label}\n`;
      keyboard.push([{ text: label, callback_data: `anm_dl_${i}` }]);
    });
    keyboard.push([{ text: '🔙 Kembali ke episode', callback_data: `anm_pg_${state.animeSeriesIdx}_1` }]);

    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

/**
 * Execute Oploverz download via host resolver.
 */
async function doAnimeOploDownload(bot, chatId, linkIndex) {
  const cache = animeBrowseCache.get(chatId);
  const links = cache?.oploLinks;
  const series = cache?.results?.[cache?.seriesIdx];
  const epNum = cache?.oploEpNum;
  if (!links || !series) return bot.sendMessage(chatId, '❌ Data hilang, coba search ulang.');

  const link = links[linkIndex];
  if (!link) return bot.sendMessage(chatId, '❌ Link tidak valid.');

  const title = `${series.title} Ep ${epNum} [${link.quality}]`;

  if (link.host === 'BUZZ') {
    // Resolve Buzzheavier → direct URL → stream download
    queueManager.addJob(chatId, title, async (jobId) => {
      let statusMsg = null;
      const status = async (txt) => {
        try {
          if (statusMsg) await bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
          else statusMsg = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
        } catch (_) {}
      };

      try {
        await status(`⏳ <b>Resolving Buzzheavier...</b>`);
        const resolved = await hostResolver.resolve('BUZZ', link.url);
        if (!resolved.directUrl) {
          return status(`❌ Gagal resolve Buzzheavier link. Coba kualitas/host lain.`);
        }

        await status(`⬇️ <b>Downloading ${escHtml(title)}...</b>`);
        const tmpDir = path.join(CONFIG.TEMP_DIR, `anime_${Date.now()}`);
        await fsp.mkdir(tmpDir, { recursive: true });
        const ext = link.format.includes('mkv') ? '.mkv' : '.mp4';
        const filePath = path.join(tmpDir, `${series.title.replace(/[^\w\s-]/g, '').slice(0, 50)} Ep${epNum} ${link.quality}${ext}`);

        const throttle = createProgressThrottler(async (bar) => {
          status(`⬇️ <b>${escHtml(title)}</b>\n${bar}`);
        }, 3000);

        await downloadStream(resolved.directUrl, filePath, (pct, speed, eta) => {
          throttle(renderProgressBar(pct, speed, eta));
        }, null, { referer: 'https://buzzheavier.com/' });

        await status(`📤 <b>Uploading ke Telegram...</b>`);
        await sendOne(bot, chatId, filePath, `🎌 ${title}`);
        await status(`✅ <b>${escHtml(title)}</b> selesai!`);
        await rimraf(tmpDir);
      } catch (err) {
        log.error(`[Anime-Oplo] download error: ${err.message}`);
        status(`❌ Download gagal: ${escHtml(err.message.slice(0, 200))}`).catch(() => {});
      }
    }, bot);
  } else {
    // For other hosts, try if it's a Gofile-like URL or just show the link
    await bot.sendMessage(chatId,
      `🔗 Host <b>${escHtml(link.host)}</b> belum didukung untuk auto-download.\n\nLink manual:\n<code>${escHtml(link.url)}</code>\n\nPassword ZIP: <code>oploverz.me</code>`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Download Otakudesu classic-layout episode via Mega.
 * @param {number} qualityIdx - index in cache.classicLinks array
 */
async function doAnimeMegaDownload(bot, chatId, qualityIdx) {
  const cache = animeBrowseCache.get(chatId);
  const classicLinks = cache?.classicLinks;
  const series = cache?.results?.[cache?.seriesIdx];
  if (!classicLinks || !series) return bot.sendMessage(chatId, '❌ Data hilang, coba search ulang.');

  const qBlock = classicLinks[qualityIdx];
  if (!qBlock) return bot.sendMessage(chatId, '❌ Quality tidak valid.');

  const megaLink = qBlock.links.find(l => l.host.toLowerCase() === 'mega');
  if (!megaLink) return bot.sendMessage(chatId, '❌ Tidak ada link Mega untuk kualitas ini.');

  const epNum = qBlock.epNumber || (cache?.lastEpNum ?? 0);
  const title = `${series.title} Ep ${epNum} [${qBlock.quality}]`;

  queueManager.addJob(chatId, title, async (jobId) => {
    let statusMsg = null;
    const status = async (txt) => {
      try {
        if (statusMsg) await bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
        else statusMsg = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
      } catch (_) {}
    };

    try {
      await status(`⏳ <b>Resolving Mega link...</b>`);
      const info = await megaResolver.getInfo(megaLink.url);
      const sizeMB = (info.size / 1024 / 1024).toFixed(1);

      await status(`⬇️ <b>Downloading ${escHtml(title)}</b>\nFile: ${escHtml(info.name)}\nSize: ${sizeMB} MB\n\nMemulai...`);

      const tmpDir = path.join(CONFIG.TEMP_DIR, `mega_${Date.now()}`);
      await fsp.mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, info.name);

      const throttle = createProgressThrottler(async (bar) => {
        status(`⬇️ <b>${escHtml(title)}</b>\n${bar}`);
      }, 3000);

      await megaResolver.downloadMega(megaLink.url, filePath, (pct, speed, eta) => {
        throttle(renderProgressBar(pct, speed, eta));
      });

      await status(`📤 <b>Uploading ke Telegram...</b>\n${escHtml(info.name)}`);
      await sendOne(bot, chatId, filePath, `🎌 ${title}`);
      await status(`✅ <b>${escHtml(title)}</b> selesai!`);
      await rimraf(tmpDir);
    } catch (err) {
      log.error(`[Anime-Mega] download error: ${err.message}`);
      status(`❌ Download gagal: ${escHtml(err.message.slice(0, 200))}`).catch(() => {});
    }
  }, bot);
}

// ─── SMART / AGGREGATE SEARCH ────────────────────────────────────────────────
/**
 * Tampilkan menu "pilih sumber" untuk query yang di-detect dari pesan bebas user.
 * Kalau source sudah di-specify (misal "pinterest gintama"), langsung dispatch tanpa menu.
 */
async function doSmartSearchMenu(bot, chatId, query, preferredSource) {
  log.info(`[SmartSearch] user ${chatId} query="${query}" pref=${preferredSource}`);

  // Auto-dispatch kalau preference kuat (bukan "all")
  if (preferredSource === 'cosplay') return doCosplayteleBrowse(bot, chatId, 'home', 1, query);
  if (preferredSource === 'r34') return doR34Browse(bot, chatId, 1, query);
  if (preferredSource === 'pinterest') return doPinSearch(bot, chatId, query);
  if (preferredSource === 'jav') return doJavBrowse(bot, chatId, query, 1);
  if (preferredSource === 'ero') return doEroBrowse(bot, chatId, query, 1);
  if (preferredSource === 'anime') return doAnimeSearch(bot, chatId, query);

  // 'all' atau tidak ada preference → tanya user dulu
  const text = `🤖 <b>Smart Search</b>\n\nKetemu query: <b>${escHtml(query)}</b>\n\nPilih sumber pencarian:`;
  const keyboard = [
    [
      { text: '📚 Cosplaytele', callback_data: `ssrc_cosplay` },
      { text: '🎬 Rule34', callback_data: `ssrc_r34` },
    ],
    [
      { text: '📌 Pinterest', callback_data: `ssrc_pinterest` },
      { text: '🎥 Javtiful', callback_data: `ssrc_jav` },
    ],
    [{ text: '🔥 EroThots', callback_data: `ssrc_ero` }],
    [{ text: '🌐 Cari di Semua Sumber', callback_data: `ssrc_all` }],
    [{ text: '❌ Batal', callback_data: 'menu_awal' }],
  ];

  // Simpan query ke state agar callback tahu apa yang harus di-search
  userStates.set(chatId, { step: 'SMART_SEARCH_PICK', query });

  const sentMsg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
  autoCleanOldMenu(bot, chatId, sentMsg.message_id);
}

/**
 * Eksekusi search paralel di 3 sumber, tampilkan top-3 per source dalam satu pesan.
 */
async function doAggregateSearch(bot, chatId, query) {
  log.info(`[Aggregate] user ${chatId} query="${query}"`);
  const loadMsg = await bot.sendMessage(chatId,
    `🌐 <b>Mencari "${escHtml(query)}" di semua sumber...</b>\n<i>Paralel query ke 5 sumber...</i>`,
    { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  const [cptRes, r34Res, pinRes, javRes, eroRes] = await Promise.allSettled([
    cosplayteleScraper.scrapeListing(1, 'home', query),
    r34Scraper.scrapeListing(1, query),
    pinterestScraper.scrapeSearch(query),
    javtifulScraper.scrapeSearch(query, 1),
    erothotsScraper.scrapeSearch(query, 1),
  ]);

  const cpt = cptRes.status === 'fulfilled' ? cptRes.value.slice(0, 3) : [];
  const r34 = r34Res.status === 'fulfilled' ? r34Res.value.slice(0, 3) : [];
  const pins = pinRes.status === 'fulfilled' ? pinRes.value.pins.slice(0, 3) : [];
  const jav = javRes.status === 'fulfilled' ? javRes.value.items.slice(0, 3) : [];
  const ero = eroRes.status === 'fulfilled' ? eroRes.value.items.slice(0, 3) : [];

  const totalFound = cpt.length + r34.length + pins.length + jav.length + ero.length;
  if (totalFound === 0) {
    return bot.editMessageText(
      `😔 <b>Tidak ada hasil</b> untuk "${escHtml(query)}" di semua sumber.`,
      {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] },
      }
    );
  }

  aggregateCache.set(chatId, { query, cpt, r34, pins, jav, ero });
  if (cpt.length) browseCache.set(chatId, { posts: cpt, page: 1, category: 'home', query, fromAggregate: true });
  if (r34.length) r34BrowseCache.set(chatId, { posts: r34, page: 1, query, fromAggregate: true });
  if (pins.length) pinBrowseCache.set(chatId, { pins, query, currentBookmark: null, nextBookmark: null, prevBookmarks: [], fromAggregate: true });
  if (jav.length) javBrowseCache.set(chatId, { items: jav, query, page: 1, hasNext: false, fromAggregate: true });
  if (ero.length) eroBrowseCache.set(chatId, { items: ero, query, page: 1, hasNext: false, fromAggregate: true });

  let text = `🌐 <b>Hasil untuk "${escHtml(query)}"</b>\n\n`;
  const buttons = [];

  if (cpt.length) {
    text += `📚 <b>Cosplaytele</b>\n`;
    cpt.forEach((p, i) => text += `  ${i + 1}. ${escHtml(p.title.slice(0, 60))}\n`);
    text += '\n';
    const row = [];
    cpt.forEach((p, i) => row.push({ text: `📚${i + 1}`, callback_data: `cpt_${i}` }));
    buttons.push(row);
  }
  if (r34.length) {
    text += `🎬 <b>Rule34</b>\n`;
    r34.forEach((p, i) => text += `  ${i + 1}. ${escHtml(p.title.slice(0, 60))}\n`);
    text += '\n';
    const row = [];
    r34.forEach((p, i) => row.push({ text: `🎬${i + 1}`, callback_data: `r34_${i}` }));
    buttons.push(row);
  }
  if (pins.length) {
    text += `📌 <b>Pinterest</b>\n`;
    pins.forEach((p, i) => {
      const icon = p.type === 'video' ? '🎬' : '🖼️';
      text += `  ${i + 1}. ${icon} ${escHtml(p.title.slice(0, 60))}\n`;
    });
    text += '\n';
    const row = [];
    pins.forEach((p, i) => row.push({ text: `📌${i + 1}`, callback_data: `pin_dl_${i}` }));
    buttons.push(row);
  }
  if (jav.length) {
    text += `🎥 <b>Javtiful</b>\n`;
    jav.forEach((v, i) => {
      const dur = v.durationText ? ` · ${v.durationText}` : '';
      text += `  ${i + 1}. ${escHtml(v.title.slice(0, 55))}${dur}\n`;
    });
    text += '\n';
    const row = [];
    jav.forEach((v, i) => row.push({ text: `🎥${i + 1}`, callback_data: `jav_${i}` }));
    buttons.push(row);
  }
  if (ero.length) {
    text += `🔥 <b>EroThots</b>\n`;
    ero.forEach((v, i) => {
      const dur = v.durationText ? ` · ${v.durationText}` : '';
      text += `  ${i + 1}. ${escHtml(v.title.slice(0, 55))}${dur}\n`;
    });
    text += '\n';
    const row = [];
    ero.forEach((v, i) => row.push({ text: `🔥${i + 1}`, callback_data: `ero_${i}` }));
    buttons.push(row);
  }

  const jumpRow = [];
  if (cpt.length) jumpRow.push({ text: '📚 Browse ▶', callback_data: `ssrc_cosplay` });
  if (r34.length) jumpRow.push({ text: '🎬 Browse ▶', callback_data: `ssrc_r34` });
  if (pins.length) jumpRow.push({ text: '📌 Browse ▶', callback_data: `ssrc_pinterest` });
  if (jav.length) jumpRow.push({ text: '🎥 Browse ▶', callback_data: `ssrc_jav` });
  if (ero.length) jumpRow.push({ text: '🔥 Browse ▶', callback_data: `ssrc_ero` });
  if (jumpRow.length) buttons.push(jumpRow);
  buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

  userStates.set(chatId, { step: 'SMART_SEARCH_PICK', query });

  await bot.editMessageText(text, {
    chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

// ─── COSPLAYTELE BROWSE HANDLERS ─────────────────────────────────────────────
/**
 * Unified browse handler untuk Cosplaytele.
 * Mode: 'home' | 'search' | 'category' | 'tag' | 'cosplayer' | 'trending'
 *   'home' / 'search'       → param = query (or null for home)
 *   'category' / 'tag'      → param = slug
 *   'cosplayer'             → param = cosplayer slug (same as category under the hood)
 *   'trending'              → param = window key ('24-hours' | '3-day' | '7-day')
 * contextLabel = human-readable header (cosplayer name, character name, etc.)
 */
async function doCosplayteleBrowse(bot, chatId, category = 'home', page = 1, query = null, mode = null, contextLabel = null) {
  // Deteksi mode dari kombinasi arg (backward compat)
  if (!mode) {
    if (query) mode = 'search';
    else if (category === 'home') mode = 'home';
    else mode = 'category';
  }

  log.info(`[User ${chatId}] Cosplaytele ${mode} "${query || category}" page=${page}`);

  const header = {
    home: '✨ Cosplaytele',
    search: `🔍 Search: ${contextLabel || query}`,
    category: `📂 ${contextLabel || category}`,
    tag: `🏷️ ${contextLabel || category}`,
    cosplayer: `👤 ${contextLabel || category}`,
    trending: `🔥 Trending (${contextLabel || category})`,
  }[mode] || '✨ Cosplaytele';

  const loadMsg = await bot.sendMessage(chatId, `${header}\n<i>Memuat...</i>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    let posts;
    if (mode === 'search') posts = await cosplayteleScraper.scrapeSearch(query, page);
    else if (mode === 'tag') posts = await cosplayteleScraper.scrapeTag(category, page);
    else if (mode === 'cosplayer') posts = await cosplayteleScraper.scrapeCategory(category, page);
    else if (mode === 'trending') posts = await cosplayteleScraper.scrapeTrending(category);
    else if (mode === 'category') posts = await cosplayteleScraper.scrapeCategory(category, page);
    else posts = await cosplayteleScraper.scrapeListing(page, 'home', query);

    if (!posts.length) {
      return bot.editMessageText(`⚠️ Tidak ada post untuk <b>${escHtml(contextLabel || query || category)}</b>.`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] },
      });
    }

    const shown = posts.slice(0, CONFIG.POSTS_PER_PAGE);
    browseCache.set(chatId, { posts: shown, page, category, query, mode, contextLabel });

    // Build rich listing dengan cosplayer + character + photo count
    let text = `${header} · Halaman ${page}\n\n`;
    shown.forEach((p, i) => {
      const parts = [];
      // Title utama (prefer formatted character+series dari parseAriaLabel)
      if (p.character && p.cosplayer) {
        parts.push(`<b>${escHtml(p.character)}</b>`);
        if (p.series) parts.push(`<i>${escHtml(p.series)}</i>`);
      } else {
        parts.push(escHtml(p.title.slice(0, 70)));
      }
      text += `${i + 1}. ${parts.join(' · ')}\n`;

      // Baris cosplayer + count
      const sub = [];
      if (p.cosplayer) sub.push(`👤 ${escHtml(p.cosplayer.slice(0, 40))}`);
      if (p.photoCount) sub.push(`📸 ${p.photoCount}${p.videoCount ? ` +${p.videoCount}🎬` : ''}`);
      if (sub.length) text += `    ${sub.join(' · ')}\n`;
    });

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 📖 Detail`, callback_data: `cpt_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 📖 Detail`, callback_data: `cpt_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `cpage_${page - 1}` });
    // Hanya tampilkan Next untuk mode yang memang paginated (bukan trending)
    if (mode !== 'trending') navRow.push({ text: 'Next ▶', callback_data: `cpage_${page + 1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (err) {
    log.error(`[Cosplaytele] browse error: ${err.message}`);
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

// ─── INIT BOT & MENUS ────────────────────────────────────────────────────────
async function sendMenuWithThumb(bot, chatId, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  try {
    if (fs.existsSync(MENU_THUMB_PATH)) {
      opts.caption = text;
      return await bot.sendPhoto(chatId, fs.createReadStream(MENU_THUMB_PATH), opts);
    }
  } catch (e) { log.warn('Gagal kirim thumbnail: ' + e.message); }

  // Fallback text only
  return await bot.sendMessage(chatId, text, opts);
}

async function sendMainMenu(bot, chatId) {
  const text =
    `👋 <b>CosTele Bot</b>\n` +
    `<i>Multi-source media scraper</i>\n\n` +
    `Pilih kategori:`;

  // Layout 2-tier: menu utama ringkas (grouped), submenu per-source.
  // Grouping:
  //   Row 1: Cosplay (primary) — 2 button cepat
  //   Row 2: Video adult — 3 button dalam 1 row (R34 / JAV / EroThots)
  //   Row 3: Image / Patreon — Pinterest + Patreon Gacha
  //   Row 4: Smart search + Profile
  //   Row 5: Utility — Terabox DL + Clear
  //   Row 6 (admin only): Dashboard
  const keyboard = [
    [
      { text: '📚 Browse Cosplay', callback_data: 'menu_browse' },
      { text: '🎲 Cosplay Gacha', callback_data: 'menu_gacha' },
    ],
    [
      { text: '🎬 Rule34', callback_data: 'menu_r34' },
      { text: '🎥 Javtiful', callback_data: 'jav_menu' },
      { text: '🔥 EroThots', callback_data: 'ero_search_prompt' },
    ],
    [
      { text: '📌 Pinterest', callback_data: 'pin_search_prompt' },
      { text: '🍁 Patreon Gacha', callback_data: 'menu_kemono_reroll' },
    ],
    [
      { text: '🎌 Anime', callback_data: 'anime_search_prompt' },
      { text: '🔎 Smart Search', callback_data: 'menu_search' },
      { text: '📊 Profile', callback_data: 'menu_profile' },
    ],
    [
      { text: '📥 Terabox DL', callback_data: 'menu_terabox' },
      { text: '🧹 Clear Chat', callback_data: 'menu_clear' },
    ],
  ];

  if (isAdmin(chatId)) {
    keyboard.push([{ text: '💻 Admin Dashboard', callback_data: 'menu_vps' }]);
  }

  const sentMsg = await sendMenuWithThumb(bot, chatId, text, keyboard);
  autoCleanOldMenu(bot, chatId, sentMsg.message_id);
}

function startBot() {
  const botOptions = { polling: true };
  if (CONFIG.LOCAL_API_URL) botOptions.baseApiUrl = CONFIG.LOCAL_API_URL;
  const bot = new TelegramBot(CONFIG.BOT_TOKEN, botOptions);
  log.ok('Bot Telegram aktif ✅');

  // Start dashboard web kalau env DASHBOARD_USER+DASHBOARD_PASS di-set
  dashboard.startDashboard({
    botStats,
    queueManager,
    statsDbRead: () => {
      // Read stats.json langsung untuk get all users
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'stats.json'), 'utf8'));
      } catch (_) { return {}; }
    },
  });

  // Set Telegram Menu Commands
  bot.setMyCommands([
    { command: '/start', description: 'Buka Menu Utama' },
    { command: '/browse', description: 'Jelajahi Postingan Cosplay Terbaru' },
    { command: '/gacha', description: '🎲 Gacha Cosplay Random (Surprise Me)' },
    { command: '/maple', description: '🍁 Gacha Patreon' },
    { command: '/r34', description: '🎬 Rule34 Video (Browse & Gacha)' },
    { command: '/pin', description: '📌 Pinterest Search (image/video)' },
    { command: '/jav', description: '🎥 Javtiful Search' },
    { command: '/ero', description: '🔥 EroThots Search' },
    { command: '/anime', description: '🎌 Anime Search (Otakudesu + Oploverz)' },
    { command: '/search', description: 'Cari Karakter / Album Cosplay' },
    { command: '/tasks', description: '🚦 Pantau Dasbor Antrean' },
    { command: '/stats', description: '🔰 Lihat Profil' },
    { command: '/health', description: '🏥 Cek kesehatan bot + semua sumber' },
    { command: '/backup', description: '💾 Export data kamu (JSON)' },
    { command: '/clear', description: '🧹 Bersihkan Seluruh Chat' }
  ]).catch(() => log.warn('Gagal set command menu.'));

  // Menus
  bot.onText(/\/start/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean chat dari sisi user
    log.info(`[User ${msg.chat.id}] Execute /start`);
    sendMainMenu(bot, msg.chat.id);
  });

  bot.onText(/\/browse/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    log.info(`[User ${msg.chat.id}] Execute /browse`);
    doCosplayteleBrowse(bot, msg.chat.id, 'home', 1);
  });

  bot.onText(/^\/gacha(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const arg = match[1] && match[1].trim().toLowerCase();
    log.info(`[User ${msg.chat.id}] Execute /gacha ${arg || '(default)'}`);
    // Shortcut mode dari argument
    const modeMap = {
      random: 'random', rand: 'random',
      trending: 'trending24', hot: 'trending24', '24h': 'trending24',
      '3d': 'trending3d', '7d': 'trending7d',
      ero: 'ero', nude: 'nude', video: 'video',
    };
    if (arg && modeMap[arg]) return doCosplayteleGacha(bot, msg.chat.id, modeMap[arg]);
    // Default: random
    doCosplayteleGacha(bot, msg.chat.id, 'random');
  });

  bot.onText(/\/maple/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    const urls = [
      'https://kemono.cr/patreon/user/3295915',
      'https://kemono.cr/patreon/user/49965584'
    ];
    const pickedUrl = urls[Math.floor(Math.random() * urls.length)];
    log.info(`[User ${msg.chat.id}] Execute /maple Kemono Gacha (${pickedUrl})`);
    doKemonoGacha(bot, msg.chat.id, pickedUrl);
  });

  bot.onText(/^\/r34(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1];
    if (query) {
      log.info(`[User ${msg.chat.id}] Execute /r34 search: ${query}`);
      doR34Browse(bot, msg.chat.id, 1, query);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /r34 (Menu)`);
      const sentMsg = await bot.sendMessage(msg.chat.id, `🎬 <b>Rule34 Video</b>\n\nPilih mode:`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Cari Video', callback_data: 'r34_search_prompt' }],
            [{ text: '📋 Browse Terbaru', callback_data: 'menu_r34_browse' }],
            [{ text: '🎲 Gacha Video Random', callback_data: 'menu_r34_gacha' }],
            [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
          ]
        }
      });
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/^\/pin(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1] && match[1].trim();
    if (query) {
      log.info(`[User ${msg.chat.id}] Execute /pin search: ${query}`);
      doPinSearch(bot, msg.chat.id, query);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /pin (prompt)`);
      userStates.set(msg.chat.id, { step: 'AWAITING_PIN_SEARCH' });
      const sentMsg = await bot.sendMessage(msg.chat.id,
        `📌 <b>Pinterest Search</b>\n\nKetik query pencarian (karakter, tag, atau kata kunci).\n` +
        `Hasil berupa gambar atau video direct.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/^\/jav(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1] && match[1].trim();

    // Special shortcut: /jav gacha / /jav random / /jav trending
    if (query) {
      const lc = query.toLowerCase();
      if (lc === 'gacha' || lc === 'random' || lc === 'surprise') {
        log.info(`[User ${msg.chat.id}] Execute /jav gacha (latest)`);
        return doJavGacha(bot, msg.chat.id, 'latest');
      }
      if (lc === 'trending' || lc === 'hot') {
        log.info(`[User ${msg.chat.id}] Execute /jav gacha (trending)`);
        return doJavGacha(bot, msg.chat.id, 'trending');
      }
      log.info(`[User ${msg.chat.id}] Execute /jav search: ${query}`);
      doJavBrowse(bot, msg.chat.id, query, 1, 'search');
    } else {
      log.info(`[User ${msg.chat.id}] Execute /jav (menu)`);
      const sentMsg = await bot.sendMessage(msg.chat.id,
        `🎥 <b>Javtiful</b>\n\nPilih mode:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Search', callback_data: 'jav_search_prompt' }],
              [
                { text: '🎰 Gacha Random', callback_data: 'javgacha_latest' },
                { text: '🔥 Trending', callback_data: 'javgacha_trending' },
              ],
              [{ text: '👘 Gacha Cosplay', callback_data: 'javgacha_cosplay' }],
              [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
            ]
          }
        }
      );
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/^\/ero(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1] && match[1].trim();
    if (query) {
      log.info(`[User ${msg.chat.id}] Execute /ero search: ${query}`);
      doEroBrowse(bot, msg.chat.id, query, 1);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /ero (prompt)`);
      userStates.set(msg.chat.id, { step: 'AWAITING_ERO_SEARCH' });
      const sentMsg = await bot.sendMessage(msg.chat.id,
        `🔥 <b>EroThots Search</b>\n\nKetik nama creator, kategori, atau kata kunci.\n` +
        `Contoh: <code>cosplay</code>, <code>onlyfans</code>, <code>asian</code>.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  // ─── ANIME ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/anime(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1] && match[1].trim();
    if (query) {
      log.info(`[User ${msg.chat.id}] Execute /anime search: ${query}`);
      doAnimeSearch(bot, msg.chat.id, query);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /anime (prompt)`);
      userStates.set(msg.chat.id, { step: 'AWAITING_ANIME_SEARCH' });
      const sentMsg = await bot.sendMessage(msg.chat.id,
        `🎌 <b>Anime Search</b> (Otakudesu + Oploverz)\n\n` +
        `Ketik judul anime yang ingin dicari.\n` +
        `Contoh: <code>one piece</code>, <code>slime</code>, <code>dr stone</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/^\/search(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    const query = match[1];
    if (query) {
      // Jika ada query langsung, tampilkan pilihan sumber
      log.info(`[User ${msg.chat.id}] Execute /search ${query}`);
      const text = `🔍 <b>Cari: "${query}"</b>\n\nPilih sumber pencarian:`;
      const keyboard = [
        [{ text: '📚 Cosplaytele', callback_data: `dosearch_cosplay_${query}` }],
        [{ text: '🎬 Rule34 Video', callback_data: `dosearch_r34_${query}` }],
        [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
      ];
      const sentMsg = await sendMenuWithThumb(bot, msg.chat.id, text, keyboard);
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /search (No Query)`);
      const text = `🔍 <b>Pencarian Karakter</b>\n\nPilih sumber pencarian:`;
      const keyboard = [
        [{ text: '📚 Cari di Cosplaytele', callback_data: 'menu_search_cosplay' }],
        [{ text: '🎬 Cari di Rule34 Video', callback_data: 'menu_search_r34' }],
        [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
      ];
      const sentMsg = await sendMenuWithThumb(bot, msg.chat.id, text, keyboard);
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  /**
   * Bulk-delete message lewat endpoint Bot API `deleteMessages` (batch max 100).
   * Lebih cepat + jauh lebih ramah rate-limit daripada loop deleteMessage per pesan.
   * Silent-fail per batch (pesan yg tidak bisa dihapus akan diabaikan).
   */
  async function bulkWipeMessages(bot, chatId, fromId, count = 800) {
    const ids = [];
    const start = Math.max(1, fromId - count);
    for (let i = fromId; i > start; i--) ids.push(i);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    for (const chunk of chunks) {
      try {
        if (typeof bot.deleteMessages === 'function') {
          await bot.deleteMessages(chatId, chunk);
        } else {
          // Fallback untuk versi lib lama
          await bot._request('deleteMessages', {
            form: { chat_id: chatId, message_ids: JSON.stringify(chunk) }
          });
        }
      } catch (e) {
        // Fallback per-id bila server menolak batch (mis. pesan di luar 48 jam window).
        for (const id of chunk) {
          bot.deleteMessage(chatId, id).catch(() => { });
        }
      }
      await sleep(120); // sedikit jeda antar batch agar ramah ke API
    }
  }

  bot.onText(/\/clear/, async (msg) => {
    log.info(`[User ${msg.chat.id}] Execute /clear (WIPING ALL)`);
    const sentMsg = await bot.sendMessage(msg.chat.id, '🧹 <i>Tornado Pembersih Aktif! Menghapus hampir seribu riwayat pesan terakhir secara mendalam...</i>', { parse_mode: 'HTML' });
    await bulkWipeMessages(bot, msg.chat.id, msg.message_id, 1000);
    // Hapus chat sapu bersihnya juga setelah beberapa detik
    setTimeout(() => {
      bot.deleteMessage(msg.chat.id, sentMsg.message_id).catch(() => { });
    }, 4000);
  });


  bot.onText(/^\/stat(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    if (!isAdmin(msg.chat.id)) return; // Hanya admin (lihat ADMIN_IDS env)

    const uptimeSec = Math.floor((Date.now() - botStats.startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const totalMemMB = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeMemMB = (os.freemem() / 1024 / 1024).toFixed(0);

    let dlFormatted = botStats.downloadedBytes > 1024 * 1024 * 1024 ? (botStats.downloadedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : (botStats.downloadedBytes / (1024 * 1024)).toFixed(2) + ' MB';

    const txt = `💻 <b>Statistik Server VPS Global</b>\n━━━━━━━━━━━━━━━━━━\n⏳ <b>Uptime:</b> ${hrs} Jam ${mins} Menit\n💾 <b>RAM Node.js:</b> ${ramMB} MB\n🖥️ <b>RAM VPS:</b> Sisa ${freeMemMB} MB / ${totalMemMB} MB\n\n📈 <b>Kinerja Bot:</b>\n🌐 Trafik Disalurkan: <b>${dlFormatted}</b>\n✅ Total Eksekusi Terkirim: <b>${botStats.totalJobs}</b> \n━━━━━━━━━━━━━━━━━━`;
    const sentMsg = await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
    autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
  });

  bot.onText(/^\/stats(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });

    const s = statsDb.getUserStats(msg.chat.id);
    const exp = Math.floor(s.downloadBytes / (1024 * 1024)) + (s.gachaCasts * 50); // 1 MB = 1 EXP, 1 Gacha = 50 EXP

    let rank = 'Newbie 🪓';
    if (isAdmin(msg.chat.id)) rank = 'DEWA 👑👑👑 (Maha Kuasa)';
    else if (exp >= 10000000) rank = 'DEWA 👑 (Legendary God)';
    else if (exp >= 100000) rank = 'Legend 🐉';
    else if (exp >= 25000) rank = 'Senior ⚔️';
    else if (exp >= 5000) rank = 'Junior 🏹';

    const totalMediaGb = s.downloadBytes > 1024 * 1024 * 1024
      ? (s.downloadBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      : (s.downloadBytes / (1024 * 1024)).toFixed(2) + ' MB';

    const uname = msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name || 'Anonim');

    const txt = `🔰 <b>Profile</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Identitas:</b> ${uname}\n` +
      `🎯 <b>Peringkat Tuan:</b> ${rank}\n` +
      `✨ <b>EXP:</b> ${exp.toLocaleString('id-ID')} Pt\n\n` +
      `🎁 <b>Gacha Dimainkan:</b> ${s.gachaCasts} Kali\n` +
      `📦 <b>Media Terkirim:</b> ${totalMediaGb} Data Super HD\n` +
      `━━━━━━━━━━━━━━━━━━\n<i>Tingkatkan EXP untuk meraih Ranking Dewa!</i>`;

    const sentMsg = await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
    autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
  });

  // /tasks — lihat status antrean queue manager
  bot.onText(/^\/tasks(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const activeArr = Array.from(queueManager.activeJobs.values());
    const pending = queueManager.snapshotQueues();
    const mySelfActive = activeArr.filter(j => j.chatId === msg.chat.id);
    const mySelfQueued = pending.find(p => p.chatId === msg.chat.id);

    let text = `🚦 <b>Dasbor Antrean</b>\n`;
    text += `📊 Global: ${activeArr.length}/${queueManager.maxConcurrency} aktif · ${pending.reduce((s, p) => s + p.pending, 0)} antri\n\n`;

    if (activeArr.length > 0) {
      text += `<b>Sedang berjalan:</b>\n`;
      activeArr.forEach(j => {
        const mine = j.chatId === msg.chat.id ? '🫵 ' : '';
        text += `${mine}#${j.id} · ${escHtml(j.title.slice(0, 50))}\n`;
        if (j.chatId === msg.chat.id && j.progress) {
          text += `   <i>${escHtml(j.progress.slice(0, 100))}</i>\n`;
        }
      });
      text += '\n';
    }

    if (pending.length > 0) {
      text += `<b>Antrean per user:</b>\n`;
      pending.forEach(p => {
        const mine = p.chatId === msg.chat.id ? '🫵 ' : '';
        text += `${mine}User ${String(p.chatId).slice(-4)}: ${p.pending} job\n`;
      });
    }

    if (activeArr.length === 0 && pending.length === 0) {
      text += `<i>Tidak ada job aktif.</i>`;
    }

    const sentMsg = await bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Refresh', callback_data: 'tasks_refresh' },
          { text: '🔙 Menu', callback_data: 'menu_awal' },
        ]]
      }
    });
    autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
  });

  // /health and /ping — same behavior, alias
  bot.onText(/^\/(health|ping)(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    log.info(`[User ${msg.chat.id}] Execute /health`);

    const loadMsg = await bot.sendMessage(msg.chat.id,
      `🏥 <b>Health Check</b>\n<i>Ping semua sumber...</i>`,
      { parse_mode: 'HTML' }
    );

    try {
      const results = await healthcheck.checkAllSources();
      const sysInfo = healthcheck.getSystemInfo(botStats.startTime);
      const report = healthcheck.formatHealthReport(results, sysInfo);
      await bot.editMessageText(report, {
        chat_id: msg.chat.id, message_id: loadMsg.message_id, parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Recheck', callback_data: 'health_recheck' },
            { text: '🔙 Menu', callback_data: 'menu_awal' },
          ]]
        }
      });
      autoCleanOldMenu(bot, msg.chat.id, loadMsg.message_id);
    } catch (e) {
      log.error(`[Health] ${e.message}`);
      await bot.editMessageText(`❌ Healthcheck gagal: ${e.message}`, {
        chat_id: msg.chat.id, message_id: loadMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });
    }
  });

  // /backup — export user data as JSON file
  bot.onText(/^\/backup(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    log.info(`[User ${msg.chat.id}] Execute /backup`);
    try {
      await fsp.mkdir(CONFIG.TEMP_DIR, { recursive: true });
      const { path: filePath, filename, payload } = backup.writeBackupFile(msg.chat.id, CONFIG.TEMP_DIR);

      const caption = `💾 <b>Backup Kamu</b>\n\n` +
        `📊 ${payload.stats.gachaCasts} gacha · ${(payload.stats.downloadBytes / 1048576).toFixed(1)} MB download\n` +
        `📚 ${payload.summary.totalHistoryEntries} history entries\n` +
        `🏷️ Categories: ${payload.summary.categories.join(', ') || '(empty)'}\n\n` +
        `<i>Simpan file ini. Untuk restore, kirim file ini kembali ke bot dengan caption <code>/restore</code>.</i>`;

      await bot.sendDocument(msg.chat.id, fs.createReadStream(filePath), {
        caption,
        parse_mode: 'HTML',
      }, {
        filename,
        contentType: 'application/json',
      });

      // Cleanup tmp file setelah 60 detik
      setTimeout(() => {
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (_) { } }
      }, 60000);
    } catch (e) {
      log.error(`[Backup] ${e.message}`);
      bot.sendMessage(msg.chat.id, `❌ Backup gagal: ${e.message}`, { parse_mode: 'HTML' }).catch(() => { });
    }
  });

  // Handle document upload dengan caption /restore — restore backup JSON
  bot.on('document', async (msg) => {
    if (!msg.document) return;
    const caption = (msg.caption || '').trim();
    if (!/^\/restore\b/i.test(caption)) return;

    const chatId = msg.chat.id;
    log.info(`[User ${chatId}] Execute /restore via document: ${msg.document.file_name}`);
    bot.deleteMessage(chatId, msg.message_id).catch(() => { });

    const loadMsg = await bot.sendMessage(chatId, `💾 <b>Restoring backup...</b>\n<i>Mengunduh file...</i>`, { parse_mode: 'HTML' });

    try {
      // Download file via getFileLink
      const fileLink = await bot.getFileLink(msg.document.file_id);
      const axios = require('axios');
      const r = await axios.get(fileLink, { responseType: 'text', timeout: 30000 });

      let backupJson;
      try {
        backupJson = typeof r.data === 'object' ? r.data : JSON.parse(r.data);
      } catch (e) {
        return bot.editMessageText(`❌ File bukan JSON valid: ${e.message.slice(0, 100)}`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        });
      }

      const result = backup.restoreBackup(chatId, backupJson);
      if (!result.restored) {
        return bot.editMessageText(`❌ Restore gagal: ${result.error}`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        });
      }

      let msg2 = `✅ <b>Restore sukses!</b>\n\n`;
      msg2 += `📚 History: ${result.entriesAdded} entry baru ditambahkan\n`;
      if (result.statsRestored) msg2 += `📊 Stats: restored dari backup\n`;
      else if (!result.sameUser) msg2 += `⚠️ <i>ChatId backup berbeda (${result.srcChatId}) — hanya history yang di-restore, bukan stats.</i>\n`;

      await bot.editMessageText(msg2, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      });
    } catch (e) {
      log.error(`[Restore] ${e.message}`);
      bot.editMessageText(`❌ Restore gagal: ${e.message.slice(0, 200)}`, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      }).catch(() => { });
    }
  });

  // Handling user messages for Terabox manual and Passwords
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    log.info(`[User ${chatId}] Mengirim pesan text: ${text.substring(0, 50)}...`);

    const state = userStates.get(chatId);

    // If awaiting password
    if (state && state.step === 'AWAITING_PASSWORD') {
      const pw = (text.toUpperCase() === 'SKIP') ? null : text;
      userStates.delete(chatId);
      bot.sendMessage(chatId, `🔐 Password set to: ${pw ? pw : '(None)'}. Memulai download...`);
      queueManager.addJob(chatId, 'Manual Download', async (jobId) => {
        await processDownload(bot, chatId, state.url, pw, 'terabox', jobId);
      }, bot);
      return;
    }

    // If awaiting search query
    if (state && state.step === 'AWAITING_SEARCH_QUERY') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian Interaktif: ${text}`);
      doCosplayteleBrowse(bot, chatId, 'home', 1, text);
      return;
    }

    // Smart Search: dispatch via intent detector
    if (state && state.step === 'AWAITING_SMART_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Smart search: ${text}`);
      try {
        const intent = await intentDetector.detectIntent(text);
        if (intent.intent === 'search' && intent.query) {
          return doSmartSearchMenu(bot, chatId, intent.query, intent.preferredSource);
        }
        // Fallback kalau tidak ke-detect: anggap query raw ke aggregate
        return doSmartSearchMenu(bot, chatId, text, 'all');
      } catch (e) {
        log.warn(`[SmartSearch] detect error: ${e.message}`);
        return doSmartSearchMenu(bot, chatId, text, 'all');
      }
    }

    // If awaiting R34 search query
    if (state && state.step === 'AWAITING_R34_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian R34Video: ${text}`);
      doR34Browse(bot, chatId, 1, text);
      return;
    }

    // If awaiting Pinterest search query
    if (state && state.step === 'AWAITING_PIN_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian Pinterest: ${text}`);
      doPinSearch(bot, chatId, text);
      return;
    }

    // If awaiting Javtiful search query
    if (state && state.step === 'AWAITING_JAV_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian Javtiful: ${text}`);
      doJavBrowse(bot, chatId, text, 1);
      return;
    }

    // If awaiting EroThots search query
    if (state && state.step === 'AWAITING_ERO_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian EroThots: ${text}`);
      doEroBrowse(bot, chatId, text, 1);
      return;
    }

    // If awaiting Anime search query
    if (state && state.step === 'AWAITING_ANIME_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian Anime: ${text}`);
      doAnimeSearch(bot, chatId, text);
      return;
    }

    // Direct link paste
    if (text.includes('terabox.com') || text.includes('1024terabox.com')) {
      userStates.set(chatId, { step: 'AWAITING_SOURCE', url: text });
      bot.sendMessage(chatId, '🔗 <b>TeraBox Link Terdeteksi!</b>\n\nApakah link ini dari 4KHD.com?', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Ya, dari 4KHD (Auto Password)', callback_data: 'src_4khd' }],
            [{ text: '❌ Bukan (Input Manual)', callback_data: 'src_other' }]
          ]
        }
      });
      return;
    }

    if (text.includes('gofile.io')) {
      queueManager.addJob(chatId, 'Gofile Eksternal', async (jobId) => {
        await processDownload(bot, chatId, text, null, 'gofile', jobId);
      }, bot);
      return;
    }

    // ── Smart Search: detect intent dari pesan bebas ──
    // Hanya kalau tidak ada state aktif (password/awaiting search) dan pesan bukan URL.
    // Skip text yang terlalu pendek (< 5 char) untuk hindari false positive pada "ya"/"ok".
    if (text.length >= 5 && text.length <= 200 && !text.startsWith('http')) {
      try {
        const intent = await intentDetector.detectIntent(text);
        if (intent.intent === 'search' && intent.query) {
          log.info(`[SmartSearch] via=${intent.via} query="${intent.query}" pref=${intent.preferredSource}`);
          bot.deleteMessage(chatId, msg.message_id).catch(() => { });
          return doSmartSearchMenu(bot, chatId, intent.query, intent.preferredSource);
        }
      } catch (e) {
        log.warn(`[SmartSearch] detect error: ${e.message}`);
      }
    }
  });

  // Callbacks
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;
    log.info(`[User ${chatId}] Hitungan Callback: ${action}`);
    bot.answerCallbackQuery(query.id).catch(() => { });

    let sid = null;
    const status = async (txt) => {
      try {
        if (!txt) {
          if (sid) bot.deleteMessage(chatId, sid).catch(() => { });
          return;
        }
        if (!sid) {
          const m = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
          sid = m.message_id;
        } else {
          await bot.editMessageText(txt, { chat_id: chatId, message_id: sid, parse_mode: 'HTML' }).catch(() => { });
        }
      } catch (e) { }
    };

    if (action.startsWith('dls_gofile_')) {
      const fileId = action.replace('dls_gofile_', '');
      const state = userStates.get(chatId);
      if (!state || state.step !== 'SELECT_GOFILE_FILE') return bot.sendMessage(chatId, 'Sesi kadaluarsa. Coba klik download ulang dari menu.');

      userStates.delete(chatId);

      // Gunakan direct link dari cache state (TANPA resolve Playwright lagi) untuk mencegah 429 rate limit
      const cachedFile = state.files && state.files.find(f => f.id === fileId);
      if (cachedFile && cachedFile.link) {
        log.info(`[Gofile] Menggunakan cache direct link untuk file: ${cachedFile.name}`);
        queueManager.addJob(chatId, `Gofile: ${cachedFile.name}`, async (jobId) => {
          // PENTING: forward cookie + accountToken session Gofile agar CDN tidak balik HTML error page.
          // Untuk link CDN gofile.io, processDownload akan pakai jalur Playwright + Authorization: Bearer.
          await processDownload(bot, chatId, cachedFile.link, null, 'gofile_direct', jobId, {
            cookie: state.cookie,
            accountToken: state.accountToken,
            fileName: cachedFile.name,
          });
        }, bot);
      } else {
        // Fallback: resolve ulang jika cache tidak ada (misal bot restart di tengah sesi)
        const gofileUrl = state.url + '#file=' + fileId;
        queueManager.addJob(chatId, `Gofile (File ${fileId})`, async (jobId) => {
          await processDownload(bot, chatId, gofileUrl, null, 'gofile', jobId);
        }, bot);
      }
      return;
    }

    // Menus
    if (action === 'menu_cosplaytele' || action === 'menu_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId);
    }
    if (action === 'menu_gacha') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      // Buka submenu gacha dengan pilihan mode
      const sentMsg = await bot.sendMessage(chatId,
        `🎲 <b>Cosplay Gacha</b>\n\nPilih pool gacha:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🎲 Random', callback_data: 'cptgacha_random' },
                { text: '🔥 24h', callback_data: 'cptgacha_trending24' },
              ],
              [
                { text: '🔥 3 Hari', callback_data: 'cptgacha_trending3d' },
                { text: '🔥 7 Hari', callback_data: 'cptgacha_trending7d' },
              ],
              [
                { text: '💋 Ero', callback_data: 'cptgacha_ero' },
                { text: '🔞 Nude', callback_data: 'cptgacha_nude' },
              ],
              [{ text: '🎬 Video', callback_data: 'cptgacha_video' }],
              [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
            ]
          }
        });
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    // Cosplaytele Gacha eksekusi: cptgacha_<mode>
    if (action.startsWith('cptgacha_')) {
      const mode = action.replace('cptgacha_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleGacha(bot, chatId, mode);
    }
    // Cosplaytele browse by cosplayer slug (from detail button)
    if (action.startsWith('cptcos_')) {
      const slug = action.replace('cptcos_', '');
      // Resolve human name dari detailCache kalau ada
      const cache = browseCache.get(chatId);
      let label = slug.replace(/-/g, ' ');
      if (cache?.detailCache) {
        for (const det of Object.values(cache.detailCache)) {
          if (det?.cosplayerSlug === slug && det.meta?.cosplayer) { label = det.meta.cosplayer; break; }
          const found = det?.allCategories?.find(c => c.slug === slug);
          if (found) { label = found.name; break; }
        }
      }
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId, slug, 1, null, 'cosplayer', label);
    }
    // Cosplaytele browse by tag slug (from detail button)
    if (action.startsWith('cpttag_')) {
      const slug = action.replace('cpttag_', '');
      const cache = browseCache.get(chatId);
      let label = slug.replace(/-/g, ' ');
      if (cache?.detailCache) {
        for (const det of Object.values(cache.detailCache)) {
          const found = det?.allTags?.find(t => t.slug === slug);
          if (found) { label = found.name; break; }
        }
      }
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId, slug, 1, null, 'tag', label);
    }
    // Cosplaytele preview (kirim 10 sample image)
    if (action.startsWith('cptprev_')) {
      const idx = parseInt(action.replace('cptprev_', ''), 10);
      return doCptPreview(bot, chatId, idx);
    }
    if (action === 'menu_awal') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return sendMainMenu(bot, chatId);
    }
    // Tasks refresh — re-render dashboard
    if (action === 'tasks_refresh') {
      const activeArr = Array.from(queueManager.activeJobs.values());
      const pending = queueManager.snapshotQueues();
      let text = `🚦 <b>Dasbor Antrean</b>\n`;
      text += `📊 Global: ${activeArr.length}/${queueManager.maxConcurrency} aktif · ${pending.reduce((s, p) => s + p.pending, 0)} antri\n\n`;
      if (activeArr.length > 0) {
        text += `<b>Sedang berjalan:</b>\n`;
        activeArr.forEach(j => {
          const mine = j.chatId === chatId ? '🫵 ' : '';
          text += `${mine}#${j.id} · ${escHtml(j.title.slice(0, 50))}\n`;
          if (j.chatId === chatId && j.progress) text += `   <i>${escHtml(j.progress.slice(0, 100))}</i>\n`;
        });
        text += '\n';
      }
      if (pending.length > 0) {
        text += `<b>Antrean per user:</b>\n`;
        pending.forEach(p => {
          const mine = p.chatId === chatId ? '🫵 ' : '';
          text += `${mine}User ${String(p.chatId).slice(-4)}: ${p.pending} job\n`;
        });
      }
      if (activeArr.length === 0 && pending.length === 0) text += `<i>Tidak ada job aktif.</i>`;
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Refresh', callback_data: 'tasks_refresh' },
            { text: '🔙 Menu', callback_data: 'menu_awal' },
          ]]
        }
      }).catch(() => { });
      return;
    }
    // Health recheck (same flow as /health)
    if (action === 'health_recheck') {
      const loadMsg = query.message;
      try {
        await bot.editMessageText(`🏥 <b>Health Check</b>\n<i>Recheck in progress...</i>`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        });
        const results = await healthcheck.checkAllSources();
        const sysInfo = healthcheck.getSystemInfo(botStats.startTime);
        const report = healthcheck.formatHealthReport(results, sysInfo);
        await bot.editMessageText(report, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Recheck', callback_data: 'health_recheck' },
              { text: '🔙 Menu', callback_data: 'menu_awal' },
            ]]
          }
        });
      } catch (e) {
        bot.editMessageText(`❌ Healthcheck gagal: ${e.message}`, {
          chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        }).catch(() => { });
      }
      return;
    }
    // Rule34 submenu (hub: search / browse terbaru / gacha)
    if (action === 'menu_r34') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const sentMsg = await bot.sendMessage(chatId,
        `🎬 <b>Rule34 Video</b>\n\nPilih mode:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Cari Video', callback_data: 'r34_search_prompt' }],
              [{ text: '📋 Browse Terbaru', callback_data: 'menu_r34_browse' }],
              [{ text: '🎲 Gacha Video Random', callback_data: 'menu_r34_gacha' }],
              [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
            ]
          }
        });
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    // Smart Search hub (prompt user untuk ngetik natural query)
    if (action === 'menu_search') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_SMART_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId,
        `🔎 <b>Smart Search</b>\n\n` +
        `Ketik apa yang kamu cari dengan bahasa natural.\n` +
        `Bot akan otomatis deteksi source terbaik.\n\n` +
        `<b>Contoh:</b>\n` +
        `• <code>cari ganyu</code> — cari di semua sumber\n` +
        `• <code>cosplay jeanne darc</code> — langsung Cosplaytele\n` +
        `• <code>MIDE-232</code> — langsung Javtiful\n` +
        `• <code>pinterest genshin</code> — langsung Pinterest\n` +
        `• <code>onlyfans leaks</code> — langsung EroThots\n\n` +
        `<i>💡 Atau pilih source langsung di bawah:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📚 Cosplaytele', callback_data: 'menu_search_cosplay' },
                { text: '🎬 Rule34', callback_data: 'menu_search_r34' },
              ],
              [
                { text: '📌 Pinterest', callback_data: 'pin_search_prompt' },
                { text: '🎥 Javtiful', callback_data: 'jav_search_prompt' },
              ],
              [{ text: '🔥 EroThots', callback_data: 'ero_search_prompt' }],
              [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
            ]
          }
        });
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'menu_kemono_reroll') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const urls = ['https://kemono.cr/patreon/user/3295915', 'https://kemono.cr/patreon/user/49965584'];
      const pickedUrl = urls[Math.floor(Math.random() * urls.length)];
      return doKemonoGacha(bot, chatId, pickedUrl);
    }

    // ── Rule34Video Callbacks ──
    if (action === 'menu_r34_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId);
    }
    if (action === 'menu_r34_gacha') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Gacha(bot, chatId);
    }
    if (action === 'r34_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_R34_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId, '🎬 <b>Pencarian Rule34Video</b>\n\nSilakan ketik tag/karakter yang ingin dicari:', { parse_mode: 'HTML' });
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'r34_back_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const cache = r34BrowseCache.get(chatId);
      // Kalau dari aggregate search, balik ke menu aggregate
      if (cache?.fromAggregate) {
        return doAggregateSearch(bot, chatId, cache.query);
      }
      return doR34Browse(bot, chatId, cache?.page || 1, cache?.query || null);
    }
    if (action.startsWith('r34page_')) {
      const pg = parseInt(action.replace('r34page_', ''));
      const cache = r34BrowseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId, pg, cache?.query || null);
    }
    if (action.startsWith('r34_') && !action.startsWith('r34dl') && !action.startsWith('r34page_')) {
      const idx = parseInt(action.replace('r34_', ''));
      const cache = r34BrowseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34PostDetail(bot, chatId, cache.posts[idx]);
    }
    if (action.startsWith('r34dlres_')) {
      // Format: r34dlres_{postIdx}_{resIdx}
      const parts = action.replace('r34dlres_', '').split('_');
      const postIdx = parseInt(parts[0]);
      const resIdx = parseInt(parts[1]);
      const cache = r34BrowseCache.get(chatId);
      if (!cache || !cache.posts[postIdx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });

      const post = cache.posts[postIdx];
      const dlMsg = await bot.sendMessage(chatId, `🎬 <b>${escHtml(post.title)}</b>\n\n<i>⏳ Mengunduh video...</i>`, { parse_mode: 'HTML' });

      try {
        const links = await r34Scraper.scrapePostDetail(post.link);
        const targetLink = links[resIdx] || links[0];
        if (!targetLink) {
          return bot.editMessageText('❌ Link tidak ditemukan.', { chat_id: chatId, message_id: dlMsg.message_id });
        }

        queueManager.addJob(chatId, `R34: ${post.title}`, async (jobId) => {
          const jobDir = path.join(CONFIG.TEMP_DIR, 'r34_' + jobId);
          await fsp.mkdir(jobDir, { recursive: true });
          const dest = path.join(jobDir, 'video.mp4');

          await downloadStream(targetLink.url, dest, null, null);
          const fsize = fs.statSync(dest).size;
          const sizeMB = (fsize / 1024 / 1024).toFixed(1);
          log.ok(`[R34] Downloaded ${targetLink.label} (${sizeMB}MB)`);

          if (fsize > CONFIG.VIDEO_MAX_BYTES) {
            await rimraf(jobDir);
            return bot.sendMessage(chatId, `⚠️ <b>${escHtml(post.title)}</b>\n\n❌ <b>${targetLink.label}</b> berukuran <b>${sizeMB}MB</b> — melebihi batas limit platform Telegram Anda saat ini (${Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024)}MB).`);
          }

          await bot.sendVideo(chatId, fs.createReadStream(dest), {
            caption: `🎬 <b>${escHtml(post.title)}</b> (${targetLink.label}, ${sizeMB}MB)`, parse_mode: 'HTML', supports_streaming: true
          });
          await rimraf(jobDir);
        }, bot);
        bot.deleteMessage(chatId, dlMsg.message_id).catch(() => { });
      } catch (e) {
        log.error('R34 DL Error: ' + e.message);
        bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chatId, message_id: dlMsg.message_id }).catch(() => { });
      }
      return;
    }

    // ── Smart Search source picker (ssrc_cosplay | ssrc_r34 | ssrc_pinterest | ssrc_jav | ssrc_all) ──
    if (action.startsWith('ssrc_')) {
      const src = action.replace('ssrc_', '');
      const state = userStates.get(chatId);
      const q = state?.query;
      if (!q) return bot.sendMessage(chatId, '⚠️ Query smart-search kadaluarsa. Kirim ulang pesan pencarian.');
      userStates.delete(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      if (src === 'cosplay') return doCosplayteleBrowse(bot, chatId, 'home', 1, q);
      if (src === 'r34') return doR34Browse(bot, chatId, 1, q);
      if (src === 'pinterest') return doPinSearch(bot, chatId, q);
      if (src === 'jav') return doJavBrowse(bot, chatId, q, 1);
      if (src === 'ero') return doEroBrowse(bot, chatId, q, 1);
      if (src === 'all') return doAggregateSearch(bot, chatId, q);
      return;
    }

    // ── Pinterest Callbacks ──
    if (action === 'pin_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_PIN_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId,
        `📌 <b>Pinterest Search</b>\n\nKetik query pencarian di kolom chat:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'pin_next') {
      const cache = pinBrowseCache.get(chatId);
      if (!cache) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /pin.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doPinSearch(bot, chatId, cache.query, cache.nextBookmark);
    }
    if (action === 'pin_prev') {
      const cache = pinBrowseCache.get(chatId);
      if (!cache || !cache.prevBookmarks?.length) return bot.sendMessage(chatId, '⚠️ Tidak ada halaman sebelumnya.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      // Pop bookmark terakhir, pakai yang sebelumnya (atau null = page 1)
      const prevList = [...cache.prevBookmarks];
      prevList.pop(); // buang current page bookmark
      const targetBookmark = prevList.pop() || null; // ambil yang lebih lama
      // Re-apply: prevBookmarks akan di-rebuild oleh doPinSearch sendiri
      pinBrowseCache.set(chatId, { ...cache, prevBookmarks: prevList });
      return doPinSearch(bot, chatId, cache.query, targetBookmark);
    }
    if (action.startsWith('pin_dl_')) {
      const idx = parseInt(action.replace('pin_dl_', ''), 10);
      const cache = pinBrowseCache.get(chatId);
      if (!cache || !cache.pins[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /pin.');
      return doPinSendItem(bot, chatId, cache.pins[idx]);
    }

    // ── Javtiful Callbacks ──
    if (action === 'jav_menu') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const sentMsg = await bot.sendMessage(chatId,
        `🎥 <b>Javtiful</b>\n\nPilih mode:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Search', callback_data: 'jav_search_prompt' }],
              [
                { text: '🎰 Gacha Random', callback_data: 'javgacha_latest' },
                { text: '🔥 Trending', callback_data: 'javgacha_trending' },
              ],
              [{ text: '👘 Gacha Cosplay', callback_data: 'javgacha_cosplay' }],
              [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
            ]
          }
        }
      );
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'jav_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_JAV_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId,
        `🎥 <b>Javtiful Search</b>\n\nKetik salah satu:\n` +
        `• Kode JAV: <code>MIDE-232</code>, <code>ssni001</code>, <code>avsa 432</code>\n` +
        `• Nama aktris: <code>matsumoto nanami</code>\n` +
        `• Tag: <code>cosplay</code>, <code>amateur</code>, <code>maid</code>\n\n` +
        `<i>💡 Bot otomatis normalisasi kode JAV.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    // Jav Gacha: javgacha_<mode>
    if (action.startsWith('javgacha_')) {
      const mode = action.replace('javgacha_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavGacha(bot, chatId, mode);
    }
    if (action === 'jav_back_browse') {
      const cache = javBrowseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      if (cache?.fromAggregate) return doAggregateSearch(bot, chatId, cache.query);
      if (!cache) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /jav.');
      return doJavBrowse(bot, chatId, cache.query, cache.page, cache.mode || 'search', cache.contextLabel);
    }
    if (action.startsWith('javpage_')) {
      const pg = parseInt(action.replace('javpage_', ''), 10);
      const cache = javBrowseCache.get(chatId);
      if (!cache) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /jav.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavBrowse(bot, chatId, cache.query, pg, cache.mode || 'search', cache.contextLabel);
    }
    if (action.startsWith('javdl_')) {
      // Format: javdl_<itemIdx>_<sourceIdx>
      const parts = action.replace('javdl_', '').split('_');
      const itemIdx = parseInt(parts[0], 10);
      const sourceIdx = parseInt(parts[1], 10);
      const cache = javBrowseCache.get(chatId);
      if (!cache || !cache.items[itemIdx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /jav.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavDownload(bot, chatId, cache.items[itemIdx], sourceIdx);
    }
    // Browse by actress: javact_<slug>
    if (action.startsWith('javact_')) {
      const slug = action.replace('javact_', '');
      // Resolve human name dari detailCache kalau ada
      const cache = javBrowseCache.get(chatId);
      let label = slug.replace(/-/g, ' ');
      if (cache?.detailCache) {
        for (const det of Object.values(cache.detailCache)) {
          const found = det.actresses?.find(a => a.slug === slug);
          if (found) { label = found.name; break; }
        }
      }
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavBrowse(bot, chatId, slug, 1, 'actress', label);
    }
    // Browse by category: javcat_<slug>
    if (action.startsWith('javcat_')) {
      const slug = action.replace('javcat_', '');
      const cache = javBrowseCache.get(chatId);
      let label = slug.replace(/-/g, ' ');
      if (cache?.detailCache) {
        for (const det of Object.values(cache.detailCache)) {
          const found = det.categories?.find(c => c.slug === slug);
          if (found) { label = found.name; break; }
        }
      }
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavBrowse(bot, chatId, slug, 1, 'category', label);
    }
    // Show related videos: javrel_<itemIdx>
    if (action.startsWith('javrel_')) {
      const idx = parseInt(action.replace('javrel_', ''), 10);
      const cache = javBrowseCache.get(chatId);
      if (!cache || !cache.items[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /jav.');
      return doJavShowRelated(bot, chatId, cache.items[idx]);
    }
    // Match jav_<idx> HARUS setelah semua javdl_/javpage_/jav_back/jav_search/javact_/javcat_/javrel_ agar tidak kecolongan.
    if (action.startsWith('jav_') && /^jav_\d+$/.test(action)) {
      const idx = parseInt(action.replace('jav_', ''), 10);
      const cache = javBrowseCache.get(chatId);
      if (!cache || !cache.items[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /jav.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doJavDetail(bot, chatId, cache.items[idx]);
    }

    // ── EroThots Callbacks ──
    if (action === 'ero_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_ERO_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId,
        `🔥 <b>EroThots Search</b>\n\nKetik nama creator, kategori, atau kata kunci:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] }
        }
      );
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'ero_back_browse') {
      const cache = eroBrowseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      if (cache?.fromAggregate) return doAggregateSearch(bot, chatId, cache.query);
      if (!cache) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /ero.');
      return doEroBrowse(bot, chatId, cache.query, cache.page);
    }
    if (action.startsWith('eropage_')) {
      const pg = parseInt(action.replace('eropage_', ''), 10);
      const cache = eroBrowseCache.get(chatId);
      if (!cache) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /ero.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doEroBrowse(bot, chatId, cache.query, pg);
    }
    if (action.startsWith('erodl_')) {
      const idx = parseInt(action.replace('erodl_', ''), 10);
      const cache = eroBrowseCache.get(chatId);
      if (!cache || !cache.items[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /ero.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doEroDownload(bot, chatId, cache.items[idx]);
    }
    if (action.startsWith('ero_') && /^ero_\d+$/.test(action)) {
      const idx = parseInt(action.replace('ero_', ''), 10);
      const cache = eroBrowseCache.get(chatId);
      if (!cache || !cache.items[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Ulangi /ero.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doEroDetail(bot, chatId, cache.items[idx]);
    }

    // ─── ANIME CALLBACKS ───────────────────────────────────────────────────────
    if (action === 'anime_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_ANIME_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId,
        `🎌 <b>Anime Search</b> (Otakudesu + Oploverz)\n\nKetik judul anime yang ingin dicari.\nContoh: <code>one piece</code>, <code>slime</code>, <code>dr stone</code>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]] } }
      );
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action.startsWith('anm_sel_')) {
      const idx = parseInt(action.replace('anm_sel_', ''), 10);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doAnimeEpisodes(bot, chatId, idx, 1);
    }
    if (action.startsWith('anm_pg_')) {
      const parts = action.replace('anm_pg_', '').split('_');
      const seriesIdx = parseInt(parts[0], 10);
      const page = parseInt(parts[1], 10);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doAnimeEpisodes(bot, chatId, seriesIdx, page);
    }
    if (action.startsWith('anm_ep_')) {
      const epNum = parseInt(action.replace('anm_ep_', ''), 10);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doAnimeDownload(bot, chatId, epNum);
    }
    if (action.startsWith('anm_dl_')) {
      const linkIdx = parseInt(action.replace('anm_dl_', ''), 10);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doAnimeOploDownload(bot, chatId, linkIdx);
    }
    if (action.startsWith('anm_mega_')) {
      const qIdx = parseInt(action.replace('anm_mega_', ''), 10);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doAnimeMegaDownload(bot, chatId, qIdx);
    }
    if (action === 'anm_back_search') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      // Re-show last search results
      const cache = animeBrowseCache.get(chatId);
      if (cache?.results?.length) {
        let text = `🎌 <b>Hasil Pencarian Anime</b>\n\n`;
        const keyboard = [];
        cache.results.slice(0, 10).forEach((r, i) => {
          const statusTag = r.status === 'Ongoing' ? '🟢' : '✅';
          text += `${i + 1}. ${statusTag} <b>${escHtml(r.title)}</b>\n`;
          keyboard.push([{ text: `${i + 1}. ${r.title.slice(0, 45)}`, callback_data: `anm_sel_${i}` }]);
        });
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      } else {
        userStates.set(chatId, { step: 'AWAITING_ANIME_SEARCH' });
        await bot.sendMessage(chatId, '🎌 Ketik judul anime untuk mencari ulang:', { reply_markup: { inline_keyboard: [[{ text: '🔙 Menu', callback_data: 'menu_awal' }]] } });
      }
      return;
    }

    if (action === 'menu_vps') {
      if (!isAdmin(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: '⛔ Akses Ditolak: Anda bukan Admin Server!', show_alert: true });
      }
      bot.answerCallbackQuery(query.id).catch(() => { });

      const uptimeSec = Math.floor((Date.now() - botStats.startTime) / 1000);
      const hrs = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const totalMemMB = (os.totalmem() / 1024 / 1024).toFixed(0);
      const freeMemMB = (os.freemem() / 1024 / 1024).toFixed(0);
      let dlFormatted = botStats.downloadedBytes > 1024 * 1024 * 1024 ? (botStats.downloadedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : (botStats.downloadedBytes / (1024 * 1024)).toFixed(2) + ' MB';

      const txt = `💻 <b>Statistik Server VPS Global</b>\n━━━━━━━━━━━━━━━━━━\n⏳ <b>Uptime:</b> ${hrs} Jam ${mins} Menit\n💾 <b>RAM Node.js:</b> ${ramMB} MB\n🖥️ <b>RAM VPS:</b> Sisa ${freeMemMB} MB / ${totalMemMB} MB\n\n📈 <b>Kinerja Bot:</b>\n🌐 Trafik Disalurkan: <b>${dlFormatted}</b>\n✅ Total Eksekusi Terkirim: <b>${botStats.totalJobs}</b> \n━━━━━━━━━━━━━━━━━━`;
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
      return;
    }

    if (action === 'menu_profile') {
      bot.answerCallbackQuery(query.id).catch(() => { });
      const s = statsDb.getUserStats(chatId);
      const exp = Math.floor(s.downloadBytes / (1024 * 1024)) + (s.gachaCasts * 50); // 1 MB = 1 EXP, 1 Gacha = 50 EXP

      let rank = 'Newbie 🪓';
      if (isAdmin(chatId)) rank = 'DEWA 👑👑👑 (Maha Kuasa)';
      else if (exp >= 10000000) rank = 'DEWA 👑 (Legendary God)';
      else if (exp >= 100000) rank = 'Legend 🐉';
      else if (exp >= 25000) rank = 'Senior ⚔️';
      else if (exp >= 5000) rank = 'Junior 🏹';

      const totalMediaGb = s.downloadBytes > 1024 * 1024 * 1024
        ? (s.downloadBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
        : (s.downloadBytes / (1024 * 1024)).toFixed(2) + ' MB';

      const uname = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Anonim');

      const txt = `🔰 <b>Profile</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Identitas:</b> ${uname}\n` +
        `🎯 <b>Peringkat:</b> ${rank}\n` +
        `✨ <b>EXP:</b> ${exp.toLocaleString('id-ID')} Pt\n\n` +
        `🎁 <b>Gacha Dimainkan:</b> ${s.gachaCasts} Kali\n` +
        `📦 <b>Media Terkirim:</b> ${totalMediaGb} Data Super HD\n` +
        `━━━━━━━━━━━━━━━━━━\n<i>Tingkatkan EXP untuk meraih Ranking Dewa!</i>`;

      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
      return;
    }

    if (action === 'menu_clear') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const sentMsg = await bot.sendMessage(chatId, '🧹 <i>Tornado Pembersih Aktif! Menghapus hampir seribu riwayat pesan terakhir secara mendalam...</i>', { parse_mode: 'HTML' });
      await bulkWipeMessages(bot, chatId, query.message.message_id, 800);
      setTimeout(() => { bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { }); }, 4000);
      return;
    }

    if (action === 'menu_terabox') {
      const msg = await sendMenuWithThumb(bot, chatId, '📥 <b>Manual Terabox</b>\n\nSilakan COPY & PASTE link TeraBox / 4KHD langsung ke chat bot ini.', [[{ text: '🔙 Kembali', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action === 'menu_search_cosplay') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_SEARCH_QUERY' });
      const msg = await sendMenuWithThumb(bot, chatId, '📚 <b>Pencarian Cosplaytele</b>\n\nSilakan ketik nama karakter, cosplayer, atau judul di kolom chat:', [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action === 'menu_search_r34') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_R34_SEARCH' });
      const msg = await sendMenuWithThumb(bot, chatId, '🎬 <b>Pencarian Rule34Video</b>\n\nSilakan ketik tag atau nama karakter di kolom chat:', [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action.startsWith('dosearch_cosplay_')) {
      const q = action.replace('dosearch_cosplay_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId, 'home', 1, q);
    }
    if (action.startsWith('dosearch_r34_')) {
      const q = action.replace('dosearch_r34_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId, 1, q);
    }

    // Pagination Cosplaytele
    if (action.startsWith('cpage_')) {
      const page = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (cache) doCosplayteleBrowse(
        bot, chatId, cache.category, page, cache.query,
        cache.mode, cache.contextLabel,
      );
      return;
    }

    // Terabox Source selection
    if (action === 'src_4khd' || action === 'src_other') {
      const state = userStates.get(chatId);
      if (!state || state.step !== 'AWAITING_SOURCE') return bot.sendMessage(chatId, 'Sesi kadaluarsa, kirim ulang link.');

      if (action === 'src_4khd') {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '✅ Pilihan 4KHD diset. Menghubungi Queue Manager...');
        queueManager.addJob(chatId, 'TeraBox (4KHD)', async (jobId) => {
          await processDownload(bot, chatId, state.url, '4KHD', 'terabox', jobId);
        }, bot);
      } else {
        userStates.set(chatId, { step: 'AWAITING_PASSWORD', url: state.url });
        bot.sendMessage(chatId, '🔑 Silakan ketik <b>Password Arsip</b> dan kirim.\n<i>(Ketik SKIP jika tidak ada password)</i>', { parse_mode: 'HTML' });
      }
      return;
    }

    // Detail Cosplaytele
    if (action.startsWith('cpt_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return bot.sendMessage(chatId, 'Data kedaluwarsa.');

      const post = cache.posts[idx];
      log.info(`[User ${chatId}] Membuka detail post: ${post.title}`);
      const dMsg = await bot.sendMessage(chatId, `🔍 Memeriksa link untuk:\n<b>${post.title}</b>`, { parse_mode: 'HTML' });

      await sendPostDetail(bot, chatId, dMsg, post, idx);
    }

    // Kembali ke Browse List (Tombol Back)
    if (action === 'back_browse') {
      const cache = browseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { }); // Hapus foto preview

      if (cache) {
        if (cache.fromAggregate) {
          return doAggregateSearch(bot, chatId, cache.query);
        }
        if (cache.isGacha) {
          // Balik ke menu gacha submenu
          const sentMsg = await bot.sendMessage(chatId,
            `🎲 <b>Cosplay Gacha</b>\n\nReroll atau pilih pool lain:`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🎲 Random', callback_data: 'cptgacha_random' },
                    { text: '🔥 24h', callback_data: 'cptgacha_trending24' },
                  ],
                  [
                    { text: '💋 Ero', callback_data: 'cptgacha_ero' },
                    { text: '🔞 Nude', callback_data: 'cptgacha_nude' },
                  ],
                  [{ text: '🎬 Video', callback_data: 'cptgacha_video' }],
                  [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }],
                ]
              }
            });
          return autoCleanOldMenu(bot, chatId, sentMsg.message_id);
        }
        // Browse normal: pertahankan mode (home/search/category/tag/cosplayer)
        return doCosplayteleBrowse(
          bot, chatId, cache.category, cache.page, cache.query,
          cache.mode, cache.contextLabel,
        );
      }
      return bot.sendMessage(chatId, 'Sesi kadaluarsa, ketik /browse kembali.');
    }

    // Auto Gofile Download dari menu
    if (action.startsWith('dlgofile_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);
      if (links && links.gofile) {
        queueManager.addJob(chatId, `Gofile: ${post.title}`, async (jobId) => {
          await processDownload(bot, chatId, links.gofile, links.password || null, 'gofile', jobId);
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link gofile tidak ditemukan untuk post ini.');
      }
    }

    // Auto MediaFire Download dari menu
    if (action.startsWith('dlmediafire_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);

      if (links && links.mediafire) {
        queueManager.addJob(chatId, `MediaFire: ${post.title}`, async (jobId) => {
          try {
            queueManager.updateJob(jobId, '⚙️ Mencari direct link MediaFire...');
            const directMFUrl = await mediafireApi.getDirectLink(links.mediafire);
            await processDownload(bot, chatId, directMFUrl, links.password || null, 'direct', jobId);
          } catch (e) {
            bot.sendMessage(chatId, `⚠️ <b>Gagal (Job #${jobId})!</b> ${e.message}`, { parse_mode: 'HTML' });
          }
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link mediafire tidak lagi tersedia untuk post ini.');
      }
    }

    // Auto SoraFolder Download dari menu
    if (action.startsWith('dlsorafolder_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);

      if (links && links.sorafolder) {
        queueManager.addJob(chatId, `SoraFolder: ${post.title}`, async (jobId) => {
          let m = await bot.sendMessage(chatId, '⏳ <b>Bypass SoraFolder:</b> Pekerja mulai meretas blokade 10 detik...', { parse_mode: 'HTML' }).catch(() => { });

          let countdown = 12;
          const timerInterval = setInterval(() => {
            if (countdown > 0) {
              if (m) bot.editMessageText(`⏳ <b>Bypass SoraFolder:</b> Melewati gerbang keamanan...\n<i>Menunggu paksa timer situs: <b>${countdown} detik</b></i>`, { chat_id: chatId, message_id: m.message_id, parse_mode: 'HTML' }).catch(() => { });
              queueManager.updateJob(jobId, `⚙️ Menembus Proteksi 10D (${countdown}s tersisa)...`);
              countdown -= 2;
            }
          }, 2000);

          try {
            const directSoraUrl = await sorafolderApi.getDirectLink(links.sorafolder);
            clearInterval(timerInterval);
            if (m) bot.deleteMessage(chatId, m.message_id).catch(() => { });
            await processDownload(bot, chatId, directSoraUrl, links.password || null, 'direct', jobId);
          } catch (e) {
            clearInterval(timerInterval);
            bot.sendMessage(chatId, `⚠️ <b>Gagal (Job #${jobId})!</b> ${e.message}`, { parse_mode: 'HTML' });
            if (m) bot.deleteMessage(chatId, m.message_id).catch(() => { });
          }
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link Sorafolder tidak lagi tersedia untuk post ini.');
      }
    }
  });

  bot.on('polling_error', (e) => log.error('Polling: ' + e.message));
}

process.on('uncaughtException', (err) => log.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => {
  if (err && err.message && err.message.includes('ETELEGRAM: 400 Bad Request: message to edit not found')) return; // Abaikan pesan yang sudah dihapus
  if (err && err.message && err.message.includes('ETELEGRAM: 400 Bad Request: not Found')) return; // Abaikan pesan yang sudah dihapus
  log.error(`Unhandled: ${err}`);
});
startBot();
