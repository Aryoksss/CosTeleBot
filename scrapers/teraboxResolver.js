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
 *   - tera-core (https://tera-core.vercel.app/api) — gratis, tanpa auth, dukung folder.
 *     v2.0: endpoint `/api` dengan `resolve=true` untuk direct download link.
 *   - direct — scraper mandiri: fetch share page → extract token → panggil API Terabox langsung.
 *     Tanpa ketergantungan third-party API. Dipakai kalau tera-core down/tidak ada cookies.
 *
 * Catatan: tera-core API pihak ketiga, bisa down sewaktu-waktu. Struktur PROVIDERS
 * sengaja dibuat agar mudah menambah provider gratis lain (tinggal push fungsinya).
 *
 * Domain Terabox yang umum (semua di-handle apa adanya oleh API):
 *   terabox.com, 1024terabox.com, terabox.app, teraboxshare.com, teraboxlink.com
 */

const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 45000, headers: { 'User-Agent': UA } });

const TERACORE_API = 'https://tera-core.vercel.app/api';

// ─── Helper: ekstrak domain dari URL Terabox ──────────────────────────────────
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch (_) {
    return 'https://www.terabox.com';
  }
}

/**
 * Resolve via tera-core v2.0 (gratis). Return array file ternormalisasi.
 * v2.0 breaking changes dari v1:
 *   - endpoint: /api2 → /api
 *   - param resolve=true untuk mendapatkan direct download link asli
 *   - field download_link menggantikan direct_link
 * @returns {Array<{filename, sizeBytes, sizeLabel, directLink, isDirectory}>}
 * @throws {Error} kalau gagal / tidak ada file
 */
async function resolveViaTeraCore(teraboxUrl) {
  // Tahap 1: Dapatkan file listing tanpa resolve (cepat, short-links).
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

  // Tahap 2: Dapatkan direct download link dengan resolve=true (lebih lambat tapi real link).
  // v2.0: field `download_link` (short redirect) vs `direct_link` resolved.
  // Kalau resolve=true gagal, fallback ke short-link dari tahap 1.
  let resolvedData = data;
  try {
    const res2 = await http.get(TERACORE_API, {
      params: { url: teraboxUrl, resolve: 'true' },
      validateStatus: () => true,
    });
    if (res2.status === 200 && res2.data && res2.data.status === 'success' && Array.isArray(res2.data.files)) {
      resolvedData = res2.data;
    }
  } catch (_) {
    // fallback ke short-link — tetap bisa dipakai (redirect akan di-follow oleh axios/downloader)
  }

  const files = resolvedData.files.map(f => ({
    filename: f.filename || 'terabox_file',
    sizeBytes: parseInt(f.size_bytes || f.size || '0', 10),
    sizeLabel: f.size || '?',
    // v2.0: `download_link` adalah field utama (bisa short redirect atau resolved direct).
    directLink: f.download_link || f.direct_link || null,
    isDirectory: !!(f.is_directory || f.is_dir),
  })).filter(f => f.directLink && !f.isDirectory);

  if (files.length === 0) throw new Error('tidak ada file dengan direct link');
  return files;
}

// ─── PROVIDER 2: Direct scraper (tanpa API eksternal) ─────────────────────────
// Fallback mandiri: fetch share page → extract token → panggil API Terabox langsung.
// Tidak bergantung pada third-party API manapun.

/**
 * Ekstrak jsToken, shorturl, sign, timestamp, logid dari HTML share page Terabox.
 */
function extractTokens(html, shareUrl) {
  const $ = cheerio.load(html);

  // Strategy 1: cari di <script> yang mengandung "try{ eval(function(p,a,c,k,e,d)"
  // atau "jsToken" / "yunData"
  const scripts = [];
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.length > 100) scripts.push(text);
  });

  // Gabungkan semua script text untuk pencarian regex
  const allScripts = scripts.join('\n');

  const tokens = {};

  // jsToken — format: "jsToken":"XXXX" atau jsToken%3DXXXX atau jsToken=XXXX
  let m = allScripts.match(/jsToken["'%3D=\s]+([A-Za-z0-9_-]+)/i);
  if (m) tokens.jsToken = m[1];

  // logid
  m = allScripts.match(/logid["'%3D=\s]+([0-9]+)/i);
  if (m) tokens.logid = m[1];

  // sign
  m = allScripts.match(/sign["'%3D=\s]+([A-Za-z0-9_-]+)/i);
  if (m) tokens.sign = m[1];

  // timestamp
  m = allScripts.match(/timestamp["'%3D=\s]+([0-9]+)/i);
  if (m) tokens.timestamp = m[1];

  // shorturl: ekstrak dari URL (bagian setelah /s/)
  m = shareUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) tokens.shorturl = m[1];

  // Fallback: coba dari yunData / window.yunData (format JSON di inline script)
  if (!tokens.jsToken || !tokens.sign || !tokens.logid) {
    // Cari JSON object yang mengandung jsToken
    m = allScripts.match(/yunData\s*[:=]\s*(\{[^}]+\})/i);
    if (m) {
      try {
        const yun = JSON.parse(m[1].replace(/'/g, '"'));
        if (yun.jsToken) tokens.jsToken = yun.jsToken;
        if (yun.sign) tokens.sign = yun.sign;
        if (yun.timestamp) tokens.timestamp = yun.timestamp;
        if (yun.logid) tokens.logid = String(yun.logid);
        if (yun.shorturl) tokens.shorturl = yun.shorturl;
      } catch (_) { /* ignore parse error */ }
    }
  }

  // Strategy 2: cari di teks mentah halaman dengan URL-encoded params
  if (!tokens.jsToken) {
    m = html.match(/jsToken=([A-Za-z0-9_-]+)/i);
    if (m) tokens.jsToken = m[1];
  }
  if (!tokens.logid) {
    m = html.match(/logid=([0-9]+)/i);
    if (m) tokens.logid = m[1];
  }
  if (!tokens.shorturl) {
    m = html.match(/shorturl=([A-Za-z0-9_-]+)/i);
    if (m) tokens.shorturl = m[1];
  }

  return tokens;
}

/**
 * Panggil API /share/list Terabox langsung untuk mendapatkan file list + dlink.
 */
async function callTeraboxApi(origin, tokens) {
  const params = {
    app_id: '250528',
    shorturl: tokens.shorturl,
    root: '1',
    dir: '0',
    page: '1',
    num: '100',
    order: 'time',
    desc: '1',
  };

  if (tokens.jsToken) params.jsToken = tokens.jsToken;
  if (tokens.sign) params.sign = tokens.sign;
  if (tokens.timestamp) params.timestamp = tokens.timestamp;
  if (tokens.logid) params.logid = tokens.logid;

  const res = await http.get(`${origin}/share/list`, {
    params,
    headers: {
      'Accept': 'application/json',
      'Referer': `${origin}/sharing/link?surl=${tokens.shorturl}`,
    },
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    throw new Error(`Terabox API HTTP ${res.status}`);
  }

  const data = res.data;
  if (data.errno !== 0) {
    throw new Error(`Terabox API errno=${data.errno}: ${data.errmsg || 'unknown'}`);
  }

  return data;
}

/**
 * Resolve via direct scraper (mandiri, tanpa API eksternal).
 * Flow: fetch share page → extract tokens → call /share/list → build download links.
 */
async function resolveViaDirect(teraboxUrl) {
  const origin = extractDomain(teraboxUrl);

  // Step 1: Fetch share page
  const pageRes = await http.get(teraboxUrl, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' },
    validateStatus: () => true,
    maxRedirects: 5,
  });

  if (pageRes.status !== 200) {
    throw new Error(`share page HTTP ${pageRes.status}`);
  }

  const html = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data);

  // Step 2: Extract tokens
  const tokens = extractTokens(html, teraboxUrl);
  if (!tokens.shorturl) {
    throw new Error('tidak bisa ekstrak shorturl dari halaman');
  }

  // Step 3: Call Terabox API
  const apiData = await callTeraboxApi(origin, tokens);

  // Step 4: Parse file list
  const list = apiData.list || [];
  if (list.length === 0) throw new Error('tidak ada file di response API');

  const files = list.map(f => ({
    filename: f.server_filename || f.filename || 'terabox_file',
    sizeBytes: parseInt(f.size || '0', 10),
    sizeLabel: f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '?',
    // dlink adalah direct download link dari Terabox API
    directLink: f.dlink || null,
    isDirectory: !!f.isdir,
  })).filter(f => f.directLink && !f.isDirectory);

  if (files.length === 0) throw new Error('tidak ada file dengan direct link (mungkin folder)');
  return files;
}

// Daftar provider gratis, dicoba berurutan sampai ada yang sukses.
const PROVIDERS = [
  { name: 'tera-core', fn: resolveViaTeraCore },
  { name: 'direct', fn: resolveViaDirect },
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
