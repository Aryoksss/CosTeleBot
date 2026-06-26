'use strict';

/**
 * jobStore — persist deskriptor job download yang BISA di-resume ke disk (jobs.json),
 * supaya kalau VPS mati/restart, unduhan yang belum selesai bisa dijalankan ulang.
 *
 * Hanya menyimpan job dengan URL STABIL (gofile page / terabox / dll yang via
 * processDownload), bukan direct-link CDN yang cepat kadaluarsa.
 *
 * Tulis SINKRON (tanpa debounce) supaya kalau proses dibunuh mendadak, state aman.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'jobs.json');
const TMP = FILE + '.tmp';

let data = null;   // { seq: number, jobs: [{id, chatId, url, password, source, opts, title, addedAt}] }

function load() {
  if (data) return data;
  try {
    data = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  } catch (_) { data = null; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.jobs)) data = { seq: 1, jobs: [] };
  return data;
}

function persist() {
  try { fs.writeFileSync(TMP, JSON.stringify(load())); fs.renameSync(TMP, FILE); }
  catch (e) { console.error(`[jobStore] gagal simpan: ${e.message}`); }
}

/** Tambah deskriptor job. Return id. */
function add(job) {
  const d = load();
  const id = d.seq++;
  d.jobs.push({ id, addedAt: Date.now(), ...job });
  persist();
  return id;
}

/** Hapus job by id (dipanggil saat job selesai/gagal final). */
function remove(id) {
  const d = load();
  const before = d.jobs.length;
  d.jobs = d.jobs.filter(j => j.id !== id);
  if (d.jobs.length !== before) persist();
}

/** Semua job pending tersimpan. */
function all() { return load().jobs.slice(); }

/** Kosongkan store (dipakai saat resume: dibaca dulu, lalu di-clear, lalu di-enqueue ulang). */
function clear() { const d = load(); d.jobs = []; persist(); }

module.exports = { add, remove, all, clear };
