'use strict';

/**
 * Settings runtime yang bisa diedit dari dashboard web (persisted ke settings.json).
 * Sumber kebenaran untuk: harga paket premium, limit kuota per tier, penerima notif tambahan.
 * Default diambil dari env saat file belum ada.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'settings.json');
const TMP = FILE + '.tmp';

let cache = null;

function defaults() {
  return {
    plans: [
      { tier: 'premium', days: 7, price: 3 },
      { tier: 'premium', days: 30, price: 8 },
      { tier: 'vvip', days: 7, price: 12 },
      { tier: 'vvip', days: 30, price: 35 },
    ],
    limits: {
      free: parseInt(process.env.LIMIT_FREE || '3', 10),
      premium: parseInt(process.env.LIMIT_PREMIUM || '15', 10),
      vvip: parseInt(process.env.LIMIT_VVIP || '50', 10),
    },
    notifyExtra: [], // [deprecated] dimigrasikan ke watchSubs saat load
    watchSubs: {},   // { "<chatId>": ["javtiful","otakudesu"] | ["all"] } — langganan watcher per-user
    watchActiveSources: null, // null = pakai default env; array = override source yang dipoll
    maintenance: false, // kalau true, bot tolak user non-admin
  };
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = { ...defaults(), ...raw, limits: { ...defaults().limits, ...(raw.limits || {}) } };
      // Migrasi: notifyExtra (list datar lama) → watchSubs (semua source) sekali.
      if (Array.isArray(cache.notifyExtra) && cache.notifyExtra.length) {
        cache.watchSubs = cache.watchSubs || {};
        for (const id of cache.notifyExtra) {
          if (!cache.watchSubs[String(id)]) cache.watchSubs[String(id)] = ['all'];
        }
        cache.notifyExtra = [];
        save();
      }
      if (!cache.watchSubs || typeof cache.watchSubs !== 'object') cache.watchSubs = {};
    } else {
      cache = defaults();
      save();
    }
  } catch (e) {
    console.error(`[Settings] gagal baca: ${e.message}`);
    cache = defaults();
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(TMP, JSON.stringify(cache, null, 2));
    fs.renameSync(TMP, FILE);
  } catch (e) {
    console.error(`[Settings] gagal simpan: ${e.message}`);
  }
}

function getAll() { return load(); }
function getPlans() { return load().plans; }
function getLimits() { return load().limits; }
function getNotifyExtra() { return load().notifyExtra || []; }
function getWatchSubs() { return load().watchSubs || {}; }

/** Update harga 1 paket (tier+days). */
function setPlanPrice(tier, days, price) {
  const s = load();
  const p = s.plans.find(x => x.tier === tier && x.days === Number(days));
  if (!p) return false;
  p.price = Number(price);
  save();
  return true;
}

/** Set limit kuota harian per tier. */
function setLimit(tier, value) {
  const s = load();
  if (!(tier in s.limits)) return false;
  s.limits[tier] = Math.max(0, parseInt(value, 10) || 0);
  save();
  return true;
}

/** Maintenance mode: true → bot tolak non-admin. */
function getMaintenance() { return !!load().maintenance; }
function setMaintenance(on) { const s = load(); s.maintenance = !!on; save(); return s.maintenance; }

// ─── WATCHER SUBSCRIPTIONS (per-user per-source) ───────────────────────────────
/** Tambah penerima watcher (default langganan semua source). */
function addWatchRecipient(chatId) {
  const s = load();
  const id = String(chatId).trim();
  if (id && !s.watchSubs[id]) { s.watchSubs[id] = ['all']; save(); }
}
/** Hapus penerima watcher. */
function removeWatchRecipient(chatId) {
  const s = load();
  const id = String(chatId).trim();
  if (s.watchSubs[id]) { delete s.watchSubs[id]; save(); }
}
/** Set daftar source langganan untuk 1 penerima. sources: array key, atau ['all']. */
function setWatchSources(chatId, sources) {
  const s = load();
  const id = String(chatId).trim();
  if (!id) return false;
  const arr = Array.isArray(sources) ? sources.map(String) : [];
  s.watchSubs[id] = arr.includes('all') ? ['all'] : arr;
  save();
  return true;
}
/** True kalau penerima `chatId` harus dapat notif untuk `sourceKey`.
 *  Penerima tanpa entry watchSubs (mis. admin) → default semua source. */
function watchShouldNotify(chatId, sourceKey) {
  const subs = load().watchSubs[String(chatId)];
  if (!subs) return true;          // tidak terdaftar eksplisit → semua
  if (subs.includes('all')) return true;
  return subs.includes(sourceKey);
}

/** Source watcher yang aktif dipoll (override env). null = default env. */
function getWatchActiveSources() { return load().watchActiveSources || null; }
function setWatchActiveSources(arr) {
  const s = load();
  s.watchActiveSources = (Array.isArray(arr) && arr.length) ? arr.map(String) : null;
  save();
  return s.watchActiveSources;
}

function addNotify(chatId) {  const s = load();
  const id = String(chatId).trim();
  if (id && !s.notifyExtra.includes(id)) { s.notifyExtra.push(id); save(); }
}
function removeNotify(chatId) {
  const s = load();
  const id = String(chatId).trim();
  s.notifyExtra = s.notifyExtra.filter(x => x !== id);
  save();
}

module.exports = { getAll, getPlans, getLimits, getNotifyExtra, getWatchSubs, setPlanPrice, setLimit, addNotify, removeNotify, getMaintenance, setMaintenance, addWatchRecipient, removeWatchRecipient, setWatchSources, watchShouldNotify, getWatchActiveSources, setWatchActiveSources };
