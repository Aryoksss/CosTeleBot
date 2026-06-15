'use strict';

/**
 * File-ID cache — dedup pengiriman file via Telegram file_id.
 *
 * Saat bot mengirim file (video/photo/document), Telegram menyimpan file di server-nya
 * dan mengembalikan `file_id`. file_id ini bisa dipakai ulang untuk mengirim file yang
 * sama TANPA download/upload ulang (Telegram copy dari server-nya sendiri) — file lokal
 * di VPS boleh dihapus. file_id stabil selama bot-nya sama.
 *
 * Dipakai untuk konten single-file dengan key stabil (Pinterest pin, Javtiful video, dll).
 * Key konvensi: `<source>:<id>[:<varian>]`  mis. `pin:123`, `jav:456:1080p`.
 *
 * Persistensi: file_id_cache.json (atomic write + debounce, sama seperti history/stats).
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'file_id_cache.json');
const TMP_FILE = CACHE_FILE + '.tmp';
const MAX_ENTRIES = 5000; // cap supaya file tidak membengkak; evict yang paling lama dipakai

let cache = null;       // { key: { fileId, type, name, savedAt, lastUsed, hits } }
let saveTimer = null;

function load() {
  if (cache) return;
  if (!fs.existsSync(CACHE_FILE)) { cache = {}; return; }
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch (e) {
    console.error(`[FileCache] gagal baca cache: ${e.message}`);
    cache = {};
  }
}

function save() {
  if (!cache) return;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(cache));
    fs.renameSync(TMP_FILE, CACHE_FILE);
  } catch (e) {
    console.error(`[FileCache] gagal simpan cache: ${e.message}`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 400);
}

function evictIfNeeded() {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ENTRIES) return;
  // Buang ~10% entri dengan lastUsed paling lama
  const sorted = keys.sort((a, b) => (cache[a].lastUsed || 0) - (cache[b].lastUsed || 0));
  const drop = Math.ceil(MAX_ENTRIES * 0.1);
  for (let i = 0; i < drop; i++) delete cache[sorted[i]];
}

/** Ambil entry cache untuk key, atau null. */
function get(key) {
  if (!key) return null;
  load();
  return cache[key] || null;
}

/** Simpan file_id untuk key. type: 'video' | 'photo' | 'document'. */
function set(key, fileId, type, name = null) {
  if (!key || !fileId) return;
  load();
  const now = Date.now();
  cache[key] = { fileId, type: type || 'document', name, savedAt: now, lastUsed: now, hits: 0 };
  evictIfNeeded();
  scheduleSave();
}

/** Tandai key baru saja dipakai (untuk eviction LRU + statistik hit). */
function bump(key) {
  load();
  const e = cache[key];
  if (!e) return;
  e.lastUsed = Date.now();
  e.hits = (e.hits || 0) + 1;
  scheduleSave();
}

/** Hapus entry (mis. saat file_id ternyata sudah stale/invalid). */
function remove(key) {
  load();
  if (cache[key]) { delete cache[key]; scheduleSave(); }
}

/** Statistik singkat untuk /stats admin. */
function stats() {
  load();
  const keys = Object.keys(cache);
  const totalHits = keys.reduce((a, k) => a + (cache[k].hits || 0), 0);
  return { entries: keys.length, totalHits };
}

function flushOnExit() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  save();
}
process.on('beforeExit', flushOnExit);
process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });

module.exports = { get, set, bump, remove, stats };
