'use strict';

/**
 * Subscriptions per-user: follow cosplayer (cosplaytele) / aktris (javtiful) tertentu.
 * Bot poll berkala; kalau ada post baru dari target yang di-follow → notif ke user itu saja.
 *
 * Beda dengan watcher (global per-source), ini per-user pilih TARGET spesifik.
 *
 * Struktur subscriptions.json:
 *   { "<chatId>": { "<key>": { code, target, label, seen: string[], addedAt } } }
 *   key  = `${code}:${target}`   code: 'c' (cosplay) | 'j' (jav)
 *   seen = daftar uid post yang sudah pernah dilihat (anti re-notify), di-cap.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'subscriptions.json');
const TMP = FILE + '.tmp';
const SEEN_CAP = 60;

let cache = null;
let saveTimer = null;

function load() {
  if (cache) return cache;
  try {
    cache = fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}) : {};
  } catch (e) {
    console.error(`[Subs] gagal baca: ${e.message}`);
    cache = {};
  }
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(TMP, JSON.stringify(cache)); fs.renameSync(TMP, FILE); }
    catch (e) { console.error(`[Subs] gagal simpan: ${e.message}`); }
  }, 400);
}

const keyOf = (code, target) => `${code}:${String(target)}`;

/** Tambah subscription. Return {ok, key, reason?}. */
function add(chatId, code, target, label) {
  const c = load();
  const id = String(chatId);
  if (!c[id]) c[id] = {};
  const key = keyOf(code, target);
  if (c[id][key]) return { ok: false, key, reason: 'exists' };
  c[id][key] = { code, target: String(target), label: label || String(target), seen: [], addedAt: Date.now() };
  scheduleSave();
  return { ok: true, key };
}

/** Hapus subscription by key. */
function remove(chatId, key) {
  const c = load();
  const id = String(chatId);
  if (c[id] && c[id][key]) { delete c[id][key]; if (!Object.keys(c[id]).length) delete c[id]; scheduleSave(); return true; }
  return false;
}

/** Daftar subscription 1 user → [{key, code, target, label, count}]. */
function list(chatId) {
  const c = load();
  const u = c[String(chatId)] || {};
  return Object.entries(u).map(([key, s]) => ({ key, code: s.code, target: s.target, label: s.label, count: (s.seen || []).length }));
}

/** Jumlah subscription user. */
function count(chatId) {
  const c = load();
  return Object.keys(c[String(chatId)] || {}).length;
}

/** Semua user yang punya subscription → [{chatId, subs:[{key,code,target,label}]}]. */
function listAllUsers() {
  const c = load();
  return Object.entries(c).map(([chatId, subs]) => ({
    chatId,
    subs: Object.entries(subs).map(([key, s]) => ({ key, code: s.code, target: s.target, label: s.label })),
  }));
}

function getSeen(chatId, key) {
  const c = load();
  const s = c[String(chatId)] && c[String(chatId)][key];
  return s ? (s.seen || []) : null; // null = subscription tidak ada
}

/** Set seen (merge uid baru ke depan, cap SEEN_CAP). */
function setSeen(chatId, key, uids) {
  const c = load();
  const s = c[String(chatId)] && c[String(chatId)][key];
  if (!s) return;
  const merged = [...uids, ...(s.seen || []).filter(u => !uids.includes(u))];
  s.seen = merged.slice(0, SEEN_CAP);
  scheduleSave();
}

module.exports = { add, remove, list, count, listAllUsers, getSeen, setSeen, keyOf };
