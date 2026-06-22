'use strict';
/**
 * watcher.js — Auto-notify post/episode baru ke ADMIN saja.
 *
 * Mekanisme: POLLING berkala (situs sumber tidak punya webhook/push).
 *   1. Tiap WATCHER_INTERVAL_MIN, ambil listing "terbaru" tiap source.
 *   2. Bandingkan uid item dengan state `watcher.json` (yang sudah pernah dilihat).
 *   3. Item yang belum ada di state = baru → kirim notif ke admin.
 *   4. Run pertama = SEED (catat semua tanpa spam notif).
 *
 * Notif anti-spam: maksimal WATCHER_MAX_NOTIFY item per source per siklus,
 * sisanya diringkas. State `seen` di-trim ke WATCHER_SEEN_LIMIT per source.
 *
 * Tombol "🔎 Buka di Bot" route ke entry-point search yang stabil
 * (doAnimeSearch / doJavBrowse / doCosplayteleBrowse) via onOpen callback.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'watcher.json');
const TMP_FILE = STATE_FILE + '.tmp';

const log = {
  info: (m) => console.log(`\x1b[36m[Watcher]\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[32m[Watcher]\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m[Watcher]\x1b[0m ${m}`),
  error: (m) => console.log(`\x1b[31m[Watcher]\x1b[0m ${m}`),
};

const cfg = {
  enabled: (process.env.WATCHER_ENABLED ?? '1') === '1',
  intervalMin: Math.max(5, parseInt(process.env.WATCHER_INTERVAL_MIN || '15', 10)),
  sources: (process.env.WATCHER_SOURCES || 'javtiful,otakudesu')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  maxNotify: parseInt(process.env.WATCHER_MAX_NOTIFY || '5', 10),
  seenLimit: parseInt(process.env.WATCHER_SEEN_LIMIT || '300', 10),
  digest: (process.env.WATCHER_DIGEST ?? '1') === '1', // kumpulkan post baru jadi 1 pesan (anti-spam)
};

let digestOverride = null; // override mode digest dari dashboard (settings); null = pakai env

let state = null;        // { [sourceKey]: { seen: string[], lastCheck, lastError, lastNew } }
let timer = null;
let running = false;
let ctx = null;          // { bot, adminChatIds, scrapers, onOpen }
let activeOverride = null; // override sumber aktif dari settings (via dashboard); null = pakai env cfg.sources

/** Sumber yang sedang dipoll: override settings (kalau ada) > env. Hanya yang punya adapter. */
function activeSources() {
  const base = (activeOverride && activeOverride.length) ? activeOverride : cfg.sources;
  return base.filter(k => ADAPTERS[k]);
}

/** Mode digest aktif? override dashboard > env. */
function digestEnabled() {
  return (digestOverride == null) ? cfg.digest : !!digestOverride;
}

// Token map untuk tombol "Buka di Bot" (in-memory, hilang saat restart — itu OK).
const tokenMap = new Map();
let tokenSeq = 1;

// ─── STATE PERSISTENCE (atomic, async) ───────────────────────────────────────
function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    state = {};
  }
  return state;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.writeFile(TMP_FILE, JSON.stringify(state), 'utf8');
      await fsp.rename(TMP_FILE, STATE_FILE);
    } catch (e) {
      log.error(`Gagal simpan state: ${e.message}`);
    }
  }, 300);
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Daftar penerima saat ini (dievaluasi tiap kirim agar perubahan dashboard langsung berlaku). */
function recipients() {
  if (typeof ctx.getRecipients === 'function') {
    try { return ctx.getRecipients() || []; } catch (_) { return ctx.adminChatIds || []; }
  }
  return ctx.adminChatIds || [];
}

// ─── SOURCE ADAPTERS ─────────────────────────────────────────────────────────
// Tiap adapter mengembalikan array item ter-normalisasi:
//   { uid, title, url, thumb, meta, route, query }
const ADAPTERS = {
  cosplaytele: {
    icon: '📚',
    label: 'Cosplaytele',
    route: 'cosplay',
    async fetch(scrapers) {
      const posts = await scrapers.cosplaytele.scrapeListing(1, 'home');
      return (posts || []).map(p => ({
        uid: p.url,
        title: p.title,
        url: p.url,
        thumb: p.thumb || null,
        meta: p.cosplayer ? `👤 ${p.cosplayer}` : '',
        route: 'cosplay',
        query: p.title,
      }));
    },
  },
  javtiful: {
    icon: '🎥',
    label: 'Javtiful',
    route: 'jav',
    async fetch(scrapers) {
      const { items } = await scrapers.javtiful.scrapeLatest(1);
      return (items || []).map(it => ({
        uid: it.link,
        title: it.title,
        url: it.link,
        thumb: it.thumb || null,
        meta: it.durationText ? `⏱️ ${it.durationText}` : '',
        route: 'jav',
        query: it.javCode || it.title,
      }));
    },
  },
  otakudesu: {
    icon: '🎌',
    label: 'Otakudesu',
    route: 'anime',
    async fetch(scrapers) {
      const rels = await scrapers.otakudesu.getLatestReleases();
      return (rels || []).map(r => ({
        uid: r.uid,
        title: `${r.title} — ${r.episode}`,
        url: r.url,
        thumb: r.thumb || null,
        meta: r.date ? `🗓️ ${r.date}` : '',
        route: 'anime',
        query: r.title,
      }));
    },
  },
  oploverz: {
    icon: '🌊',
    label: 'Oploverz',
    route: 'anime',
    async fetch(scrapers) {
      if (!scrapers.oploverz) return [];
      const list = await scrapers.oploverz.getLatest(1);
      return (list || []).map(s => ({
        uid: 'oplo:' + (s.slug || s.id),
        title: s.title,
        url: '',
        thumb: s.poster || null,
        meta: s.status ? `📺 ${s.status}` : '',
        route: 'anime',
        query: s.title,
      }));
    },
  },
  kusonime: {
    icon: '🌸',
    label: 'Kusonime',
    route: 'anime',
    async fetch(scrapers) {
      if (!scrapers.kusonime) return [];
      const list = await scrapers.kusonime.scrapeListing(1);
      return (list || []).map(p => ({
        uid: p.url,
        title: p.title,
        url: p.url,
        thumb: p.poster || null,
        meta: '',
        route: 'anime',
        query: p.title,
      }));
    },
  },
  erothots: {
    icon: '🔥',
    label: 'EroThots',
    route: 'ero',
    async fetch(scrapers) {
      if (!scrapers.erothots) return [];
      const { items } = await scrapers.erothots.scrapeBrowse(1);
      return (items || []).map(it => ({
        uid: it.link,
        title: it.title,
        url: it.link,
        thumb: it.thumb || null,
        meta: it.durationText ? `⏱️ ${it.durationText}` : '',
        route: 'ero',
        query: it.title,
      }));
    },
  },
  xnxx: {
    icon: '🟦',
    label: 'XNXX',
    route: 'xnxx',
    async fetch(scrapers) {
      if (!scrapers.xnxx) return [];
      const { items } = await scrapers.xnxx.scrapeBrowse(1);
      return (items || []).map(it => ({
        uid: it.link,
        title: it.title,
        url: it.link,
        thumb: it.thumb || null,
        meta: [it.durationText, it.quality].filter(Boolean).join(' · '),
        route: 'xnxx',
        query: it.title,
      }));
    },
  },
};

// ─── NOTIFY ──────────────────────────────────────────────────────────────────
function makeToken(route, query) {
  const token = String(tokenSeq++);
  tokenMap.set(token, { route, query, ts: Date.now() });
  // Batasi ukuran map (buang yang terlama).
  if (tokenMap.size > 500) {
    const oldest = [...tokenMap.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) tokenMap.delete(oldest[0]);
  }
  return token;
}

function consumeToken(token) {
  return tokenMap.get(token) || null;
}

async function notifyAdmins(adapter, item, sourceKey) {
  const token = makeToken(item.route, item.query);
  const caption =
    `${adapter.icon} <b>${escHtml(adapter.label)}</b> — post baru!\n\n` +
    `<b>${escHtml(item.title)}</b>\n` +
    (item.meta ? `${escHtml(item.meta)}\n` : '') +
    (item.url ? `\n<a href="${escHtml(item.url)}">🔗 Buka sumber</a>` : '');

  const keyboard = {
    inline_keyboard: [[{ text: '🔎 Buka di Bot', callback_data: `watch_open_${token}` }]],
  };

  for (const chatId of recipients()) {
    if (ctx.shouldNotify && !ctx.shouldNotify(chatId, sourceKey)) continue;
    try {
      if (item.thumb) {
        await ctx.bot.sendPhoto(chatId, item.thumb, { caption, parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: false });
      }
    } catch (e) {
      // Thumbnail eksternal kadang ditolak Telegram → fallback teks.
      try {
        await ctx.bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (_) { }
    }
  }
}

async function notifySummary(adapter, extraCount, sourceKey) {
  const text = `${adapter.icon} <b>${escHtml(adapter.label)}</b>: +${extraCount} post baru lainnya (tidak ditampilkan agar tidak spam).`;
  for (const chatId of recipients()) {
    if (ctx.shouldNotify && !ctx.shouldNotify(chatId, sourceKey)) continue;
    ctx.bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => { });
  }
}

/** Mode lama: kirim tiap post baru sebagai kartu terpisah (banyak pesan). */
async function sendIndividual(freshBySource) {
  for (const [key, fresh] of Object.entries(freshBySource)) {
    const adapter = ADAPTERS[key];
    const toShow = fresh.slice(0, cfg.maxNotify);
    for (const item of toShow) {
      await notifyAdmins(adapter, item, key);
      await new Promise(r => setTimeout(r, 400));
    }
    if (fresh.length > toShow.length) await notifySummary(adapter, fresh.length - toShow.length, key);
  }
}

/** Mode digest: kumpulkan SEMUA post baru jadi 1 pesan per penerima (anti-spam). */
async function sendDigest(freshBySource) {
  const keys = activeSources().filter(k => freshBySource[k] && freshBySource[k].length);
  if (!keys.length) return;

  // Buat token sekali per item (dipakai ulang lintas penerima).
  for (const k of keys) for (const it of freshBySource[k]) it._token = makeToken(it.route, it.query);

  const totalNew = keys.reduce((a, k) => a + freshBySource[k].length, 0);
  const perSourceCap = Math.max(3, cfg.maxNotify); // jumlah judul ditampilkan per source
  const MAX_BTN = 8;

  for (const chatId of recipients()) {
    const myKeys = keys.filter(k => !ctx.shouldNotify || ctx.shouldNotify(chatId, k));
    if (!myKeys.length) continue;
    const myTotal = myKeys.reduce((a, k) => a + freshBySource[k].length, 0);

    let text = `🔔 <b>${myTotal} post baru</b> dari ${myKeys.length} sumber\n`;
    const btns = [];
    let n = 0;
    for (const k of myKeys) {
      const ad = ADAPTERS[k];
      const items = freshBySource[k];
      text += `\n${ad.icon} <b>${escHtml(ad.label)}</b> · ${items.length} baru\n`;
      for (const it of items.slice(0, perSourceCap)) {
        n++;
        const title = escHtml((it.title || 'Untitled').slice(0, 90));
        text += `${n}. ${it.url ? `<a href="${escHtml(it.url)}">${title}</a>` : title}\n`;
        if (btns.length < MAX_BTN) btns.push({ text: `🔎 ${n}`, callback_data: `watch_open_${it._token}` });
      }
      if (items.length > perSourceCap) text += `<i>+${items.length - perSourceCap} lainnya…</i>\n`;
    }
    if (text.length > 3900) text = text.slice(0, 3900) + '\n<i>…dipotong</i>';
    const keyboard = [];
    for (let i = 0; i < btns.length; i += 5) keyboard.push(btns.slice(i, i + 5));

    try {
      await ctx.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (_) { }
    await new Promise(r => setTimeout(r, 200));
  }
  log.ok(`[Watcher] digest: ${totalNew} post baru dari ${keys.length} sumber → ${recipients().length} penerima.`);
}

// ─── CORE POLL ───────────────────────────────────────────────────────────────
async function checkSource(key) {
  const adapter = ADAPTERS[key];
  if (!adapter) return { key, error: 'adapter tidak dikenal' };

  if (!state[key]) state[key] = { seen: [], lastCheck: 0, lastError: null, lastNew: 0 };
  const s = state[key];

  let items;
  try {
    items = await adapter.fetch(ctx.scrapers);
  } catch (e) {
    s.lastError = e.message;
    s.lastCheck = Date.now();
    scheduleSave();
    log.warn(`${adapter.label}: gagal fetch — ${e.message}`);
    return { key, error: e.message };
  }

  s.lastError = null;
  s.lastCheck = Date.now();

  const seenSet = new Set(s.seen);
  const firstRun = s.seen.length === 0;
  const fresh = items.filter(it => it.uid && !seenSet.has(it.uid));

  // Update seen set dengan SEMUA uid sekarang (paling baru di depan).
  const allUids = items.map(it => it.uid).filter(Boolean);
  const merged = [...allUids, ...s.seen.filter(u => !allUids.includes(u))];
  s.seen = merged.slice(0, cfg.seenLimit);

  if (firstRun) {
    s.lastNew = 0;
    scheduleSave();
    log.info(`${adapter.label}: seed ${items.length} item (tanpa notif).`);
    return { key, seeded: items.length, fresh: [] };
  }

  s.lastNew = fresh.length;
  scheduleSave();

  if (fresh.length === 0) {
    log.info(`${adapter.label}: tidak ada post baru.`);
    return { key, new: 0, fresh: [] };
  }

  log.ok(`${adapter.label}: ${fresh.length} post baru.`);
  return { key, new: fresh.length, fresh };
}

async function runCycle() {
  if (running) { log.warn('Siklus sebelumnya masih jalan, skip.'); return; }
  running = true;
  try {
    const freshBySource = {};
    for (const key of activeSources()) {
      const r = await checkSource(key);
      if (r && r.fresh && r.fresh.length) freshBySource[key] = r.fresh;
    }
    if (Object.keys(freshBySource).length) {
      if (digestEnabled()) await sendDigest(freshBySource);
      else await sendIndividual(freshBySource);
    }
  } catch (e) {
    log.error(`runCycle error: ${e.message}`);
  } finally {
    running = false;
  }
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {TelegramBot} opts.bot
 * @param {Array<number|string>} opts.adminChatIds  tujuan notif (admin)
 * @param {object} opts.scrapers  { cosplaytele, javtiful, otakudesu }
 * @param {(route, query, chatId)=>any} opts.onOpen  router tombol "Buka di Bot"
 */
function startWatcher(opts) {
  ctx = opts;
  if (Array.isArray(opts.activeSources) && opts.activeSources.length) {
    activeOverride = opts.activeSources.filter(k => ADAPTERS[k]);
  }
  if (opts.digest != null) digestOverride = !!opts.digest;

  if (!cfg.enabled) { log.info('WATCHER_ENABLED!=1 → watcher nonaktif.'); return; }
  if (!ctx.adminChatIds || ctx.adminChatIds.length === 0) {
    log.warn('Tidak ada admin chat id → watcher nonaktif (notif tidak punya tujuan).');
    return;
  }
  if (activeSources().length === 0) { log.warn('Tidak ada sumber watcher aktif → nonaktif.'); return; }

  loadState();
  log.info(`Aktif. Sumber: [${activeSources().join(', ')}] · tiap ${cfg.intervalMin} menit · admin: ${ctx.adminChatIds.length}.`);

  // Cek pertama setelah 20 detik (biar bot settle dulu), lalu interval.
  setTimeout(() => runCycle(), 20000);
  timer = setInterval(() => runCycle(), cfg.intervalMin * 60 * 1000);
  if (timer.unref) timer.unref();
}

function stopWatcher() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getStatus() {
  const act = activeSources();
  return {
    enabled: cfg.enabled,
    intervalMin: cfg.intervalMin,
    sources: act,
    running,
    state: state ? Object.fromEntries(act.map(k => [k, {
      seen: state[k]?.seen?.length || 0,
      lastCheck: state[k]?.lastCheck || 0,
      lastError: state[k]?.lastError || null,
      lastNew: state[k]?.lastNew || 0,
    }])) : {},
  };
}

async function forceCheck() {
  await runCycle();
  return getStatus();
}

/** Meta semua source watcher (key, label, icon) untuk UI dashboard. */
function getSourcesMeta() {
  return Object.entries(ADAPTERS).map(([key, a]) => ({ key, label: a.label, icon: a.icon }));
}

/** Source yang aktif dipoll saat ini (override settings > env). */
function getActiveSources() {
  return activeSources();
}

/** Set source aktif secara live (dari dashboard). arr null/[] → balik ke env default. */
function setActiveSources(arr) {
  activeOverride = (Array.isArray(arr) && arr.length) ? arr.filter(k => ADAPTERS[k]) : null;
  return getActiveSources();
}

/** Mode digest aktif sekarang? */
function isDigest() { return digestEnabled(); }
/** Set mode digest live (dari dashboard). null → balik ke env. */
function setDigest(on) { digestOverride = (on == null) ? null : !!on; return digestEnabled(); }

module.exports = {
  startWatcher,
  stopWatcher,
  getStatus,
  forceCheck,
  consumeToken,
  getSourcesMeta,
  getActiveSources,
  setActiveSources,
  isDigest,
  setDigest,
  _config: cfg,
};
