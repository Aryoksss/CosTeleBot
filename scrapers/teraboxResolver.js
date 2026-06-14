'use strict';
/**
 * Terabox resolver — provider GRATIS untuk meng-extract direct download link dari
 * share link Terabox.
 *
 * Dipakai sebagai FALLBACK oleh getApiResult() di telegram-bot.js: kalau xAPIverse
 * (provider berbayar utama) gagal / kehabisan credit / key-nya tidak di-set, bot
 * otomatis jatuh ke provider gratis di sini.
 *
 * Provider saat ini:
 *   - tera-core (https://tera-core.vercel.app/api2) — gratis, tanpa auth, dukung folder.
 *
 * Catatan: tera-core API pihak ketiga, bisa down sewaktu-waktu. Struktur PROVIDERS
 * sengaja dibuat agar mudah menambah provider gratis lain (tinggal push fungsinya).
 *
 * Domain Terabox yang umum (semua di-handle apa adanya oleh API):
 *   terabox.com, 1024terabox.com, terabox.app, teraboxshare.com, teraboxlink.com
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 45000, headers: { 'User-Agent': UA } });

const TERACORE_API = 'https://tera-core.vercel.app/api2';

/**
 * Resolve via tera-core (gratis). Return array file ternormalisasi.
 * @returns {Array<{filename, sizeBytes, sizeLabel, directLink, isDirectory}>}
 * @throws {Error} kalau gagal / tidak ada file
 */
async function resolveViaTeraCore(teraboxUrl) {
  const res = await http.get(TERACORE_API, {
    params: { url: teraboxUrl },
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 150) : String(res.data).slice(0, 150);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const data = res.data;
  if (!data || data.status !== 'success' || !Array.isArray(data.files) || data.files.length === 0) {
    throw new Error(data && data.message ? data.message : 'no files returned');
  }

  const files = data.files.map(f => ({
    filename: f.filename || 'terabox_file',
    sizeBytes: parseInt(f.size_bytes || '0', 10),
    sizeLabel: f.size || '?',
    directLink: f.direct_link || f.download_link || null,
    isDirectory: !!f.is_directory,
  })).filter(f => f.directLink && !f.isDirectory);

  if (files.length === 0) throw new Error('tidak ada file dengan direct link');
  return files;
}

// Daftar provider gratis, dicoba berurutan sampai ada yang sukses.
const PROVIDERS = [
  { name: 'tera-core', fn: resolveViaTeraCore },
];

/**
 * Resolve share Terabox via provider gratis (urut). Return provider pertama yang sukses.
 * @returns {{files: Array, source: string}}
 * @throws {Error} kalau semua provider gagal
 */
async function resolve(teraboxUrl) {
  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const files = await p.fn(teraboxUrl);
      return { files, source: p.name };
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error(`semua provider gratis gagal — ${errors.join(' | ')}`);
}

/**
 * Pilih file terbesar yang punya direct link (untuk pipeline single-file).
 */
function pickBestFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return [...files].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0];
}

module.exports = { resolve, resolveViaTeraCore, pickBestFile };
