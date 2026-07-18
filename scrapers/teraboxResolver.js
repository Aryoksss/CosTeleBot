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
//
// Support 2 format halaman Terabox:
//   A. terabox.com (lama)        — HTML dengan yunData/jsToken inline
//   B. 1024tera.com / terabox.app (baru, SPA) — jsToken di eval(decodeURIComponent(...))

/**
 * Ekstrak tokens dari HTML share page Terabox (support format lama & baru).
 * @param {string} html
 * @param {string} finalUrl — URL akhir setelah redirect (untuk ekstrak origin + surl)
 */
function extractTokens(html, finalUrl) {
  const tokens = {};

  // ── jsToken: coba 2 pola ────────────────────────────────────────────────
  // Pola A (1024tera.com SPA): eval(decodeURIComponent(...jsToken%20%3D%20a...fn%28%22TOKEN%22...))
  let m = html.match(/jsToken%20%3D%20a%7D%3Bfn%28%22([A-Fa-f0-9]+?)%22/);
  if (m) tokens.jsToken = m[1];

  // Pola B (terabox.com klasik): "jsToken":"XXXX" atau jsToken=XXXX
  if (!tokens.jsToken) {
    m = html.match(/jsToken["'%3D=\s]+([A-Za-z0-9_-]+)/i);
    if (m) tokens.jsToken = m[1];
  }

  // ── logid: coba 2 pola ──────────────────────────────────────────────────
  // Pola A: dp-logid=xxxxx (di og:image meta tag)
  m = html.match(/dp-logid=(\d+)/);
  if (m) tokens.logid = m[1];

  // Pola B: logid="xxxxx"
  if (!tokens.logid) {
    m = html.match(/logid["'%3D=\s]+([0-9]+)/i);
    if (m) tokens.logid = m[1];
  }

  // ── sign & timestamp (format klasik) ─────────────────────────────────────
  m = html.match(/sign["'%3D=\s]+([A-Za-z0-9_-]+)/i);
  if (m) tokens.sign = m[1];
  m = html.match(/timestamp["'%3D=\s]+([0-9]+)/i);
  if (m) tokens.timestamp = m[1];

  // ── shorturl: dari final URL parameter surl= ─────────────────────────────
  m = finalUrl.match(/surl=([A-Za-z0-9_-]+)/i);
  if (m) tokens.shorturl = m[1];

  // Fallback: dari path /s/XXXX
  if (!tokens.shorturl) {
    m = finalUrl.match(/\/s\/([A-Za-z0-9_-]+)/i);
    if (m) tokens.shorturl = m[1];
  }

  // ── origin: dari templateData JSON (format SPA) ──────────────────────────
  m = html.match(/"origin":"([^"]+)"/);
  if (m) tokens.origin = m[1];

  // ── Fallback yunData (format klasik) ─────────────────────────────────────
  if (!tokens.jsToken || !tokens.sign) {
    const scripts = [];
    const $ = cheerio.load(html);
    $('script').each((_, el) => {
      const text = $(el).html() || '';
      if (text.length > 100) scripts.push(text);
    });
    const allScripts = scripts.join('\n');
    m = allScripts.match(/yunData\s*[:=]\s*(\{[^}]+\})/i);
    if (m) {
      try {
        const yun = JSON.parse(m[1].replace(/'/g, '"'));
        if (!tokens.jsToken && yun.jsToken) tokens.jsToken = yun.jsToken;
        if (!tokens.sign && yun.sign) tokens.sign = yun.sign;
        if (!tokens.timestamp && yun.timestamp) tokens.timestamp = yun.timestamp;
        if (!tokens.logid && yun.logid) tokens.logid = String(yun.logid);
        if (!tokens.shorturl && yun.shorturl) tokens.shorturl = yun.shorturl;
      } catch (_) { /* ignore parse error */ }
    }
  }

  return tokens;
}

/**
 * Strip leading "1" dari shorturl (format 1024tera.com).
 * Contoh: "182LURMwETEYdY6qgyJHycg" → "82LURMwETEYdY6qgyJHycg"
 */
function normalizeShorturl(surl) {
  if (!surl) return surl;
  return surl.startsWith('1') && surl.length > 10 ? surl.slice(1) : surl;
}

/**
 * Resolve via direct scraper (mandiri, tanpa API eksternal).
 * Flow: fetch share page → extract tokens → call /share/list → build file list.
 *
 * Catatan: untuk format SPA (1024tera.com), API /share/list TIDAK mengembalikan
 * dlink (direct download link) tanpa cookies login. File tetap bisa di-list,
 * tapi download link mungkin kosong. Kalau itu terjadi, fallback ke Playwright
 * (lihat resolveViaBrowser).
 */
async function resolveViaDirect(teraboxUrl) {
  // Step 1: Fetch share page — ikuti redirect untuk dapat origin + shorturl final
  const pageRes = await http.get(teraboxUrl, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' },
    validateStatus: () => true,
    maxRedirects: 5,
  });

  if (pageRes.status !== 200) {
    throw new Error(`share page HTTP ${pageRes.status}`);
  }

  const html = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data);
  const finalUrl = pageRes.request.res.responseUrl || teraboxUrl;

  // Step 2: Extract tokens dari HTML + final URL
  const tokens = extractTokens(html, finalUrl);
  const origin = tokens.origin || extractDomain(finalUrl);
  tokens.shorturl = normalizeShorturl(tokens.shorturl);

  if (!tokens.shorturl) {
    throw new Error('tidak bisa ekstrak shorturl dari halaman');
  }

  // Step 3: Call /share/list API
  const params = {
    app_id: '250528',
    shorturl: tokens.shorturl,
    root: '1', dir: '0', page: '1', num: '100',
    order: 'time', desc: '1',
  };
  if (tokens.jsToken) params.jsToken = tokens.jsToken;
  if (tokens.logid) params.logid = tokens.logid;
  if (tokens.sign) params.sign = tokens.sign;
  if (tokens.timestamp) params.timestamp = tokens.timestamp;

  const apiRes = await http.get(`${origin}/share/list`, {
    params,
    headers: {
      'Accept': 'application/json',
      'Referer': finalUrl,
    },
    validateStatus: () => true,
  });

  if (apiRes.status !== 200) {
    throw new Error(`Terabox API HTTP ${apiRes.status}`);
  }

  const data = apiRes.data;
  if (data.errno !== 0) {
    // errno=2130 → link private/expired, errno=105 → invalid
    throw new Error(`Terabox API errno=${data.errno}: ${data.errmsg || 'unknown'}`);
  }

  // Step 4: Parse file list
  const list = data.list || [];
  if (list.length === 0) throw new Error('tidak ada file di response API');

  const files = list.map(f => ({
    filename: f.server_filename || f.filename || 'terabox_file',
    sizeBytes: parseInt(f.size || '0', 10),
    sizeLabel: f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '?',
    // dlink bisa kosong untuk format SPA tanpa cookies — ditangani caller
    directLink: f.dlink || null,
    isDirectory: !!(f.isdir && f.isdir !== '0'),
  })).filter(f => !f.isDirectory);

  if (files.length === 0) {
    // Mungkin folder / tidak ada file non-direktori — tetap return folder items
    const allFiles = list.map(f => ({
      filename: f.server_filename || f.filename || 'terabox_file',
      sizeBytes: parseInt(f.size || '0', 10),
      sizeLabel: f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '?',
      directLink: f.dlink || null,
      isDirectory: !!(f.isdir && f.isdir !== '0'),
    }));
    if (allFiles.length === 0) throw new Error('tidak ada file sama sekali');
    return allFiles;
  }

  return files;
}

// Daftar provider gratis, dicoba berurutan sampai ada yang sukses.
// Prioritas: tera-core (cepat, third-party) → direct (axios, mandiri) → browser (Playwright, berat)
const PROVIDERS = [
  { name: 'tera-core', fn: resolveViaTeraCore },
  { name: 'direct', fn: resolveViaDirect },
];

// ─── PROVIDER 3: Playwright Browser (last resort, untuk SPA tanpa cookies) ────
// Dipakai hanya kalau tera-core & direct gagal / tidak menghasilkan dlink.
// Membuka halaman share Terabox di headless Chromium, menunggu SPA render,
// lalu intercept network request untuk mendapatkan download link.

let _resolveViaBrowser = null; // lazy-loaded (playwright berat)

async function resolveViaBrowser(teraboxUrl) {
  if (!_resolveViaBrowser) {
    // eslint-disable-next-line global-require
    const { chromium } = require('playwright-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    chromium.use(StealthPlugin());

    _resolveViaBrowser = async (url) => {
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const ctx = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        });
        const page = await ctx.newPage();

        // Kumpulkan download links dari network interception
        const downloadLinks = []; // { filename, url }
        const seenUrls = new Set();

        page.on('response', async (res) => {
          const resUrl = res.url();
          // Tangkap redirect 302 dari klik download → biasanya ke CDN Terabox
          if (res.status() === 302 && (resUrl.includes('terabox') || resUrl.includes('tera') || resUrl.includes('baidu'))) {
            const loc = res.headers()['location'];
            if (loc && !seenUrls.has(loc)) {
              seenUrls.add(loc);
              // Coba dapatkan filename dari content-disposition
              const disp = res.headers()['content-disposition'] || '';
              const fnMatch = disp.match(/filename[*]?=(?:UTF-8'')?([^;]+)/i);
              let fname = fnMatch ? decodeURIComponent(fnMatch[1].replace(/"/g, '')) : '';
              downloadLinks.push({ filename: fname, url: loc });
            }
          }
          // Tangkap juga XHR API response yang mengandung dlink
          try {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('json') && resUrl.includes('/share/')) {
              const json = await res.json();
              if (json.list) {
                for (const f of json.list) {
                  if (f.dlink && !seenUrls.has(f.dlink)) {
                    seenUrls.add(f.dlink);
                    downloadLinks.push({
                      filename: f.server_filename || f.filename || '',
                      url: f.dlink,
                      sizeBytes: parseInt(f.size || '0', 10),
                    });
                  }
                }
              }
            }
          } catch (_) { /* bukan JSON atau bukan response yg dicari */ }
        });

        // Buka halaman & tunggu SPA render (file list muncul)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000); // tunggu SPA fetch API

        // Kalau intercept dapat links dari API response, return langsung
        if (downloadLinks.length > 0) {
          return downloadLinks.map(dl => ({
            filename: dl.filename || 'terabox_file',
            sizeBytes: dl.sizeBytes || 0,
            sizeLabel: dl.sizeBytes ? `${(dl.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '?',
            directLink: dl.url,
            isDirectory: false,
          }));
        }

        // Fallback: coba klik download button di DOM
        // Cari semua tombol/link download
        const dlButtons = await page.$$('a[download], button[class*="download"], a[class*="download"], [class*="dl-btn"]');
        for (const btn of dlButtons.slice(0, 5)) {
          try {
            const [newPage] = await Promise.all([
              ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
              btn.click({ noWaitAfter: true }),
            ]);
            if (newPage) {
              const dlUrl = newPage.url();
              if (dlUrl && !dlUrl.includes('terabox') && !dlUrl.includes('sharing')) {
                downloadLinks.push({ filename: '', url: dlUrl });
              }
              await newPage.close().catch(() => {});
            }
          } catch (_) { /* tombol ini bukan download */ }
        }

        await ctx.close();

        if (downloadLinks.length === 0) {
          throw new Error('Browser: tidak bisa mendapatkan download link dari halaman');
        }

        return downloadLinks.map(dl => ({
          filename: dl.filename || 'terabox_file',
          sizeBytes: dl.sizeBytes || 0,
          sizeLabel: dl.sizeBytes ? `${(dl.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '?',
          directLink: dl.url,
          isDirectory: false,
        }));
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    };
  }

  return _resolveViaBrowser(teraboxUrl);
}

// Provider Playwright hanya dipasang kalau chromium tersedia (cek lazy)
function _hasPlaywright() {
  try {
    require.resolve('playwright-extra');
    return true;
  } catch (_) {
    return false;
  }
}

// Inisialisasi PROVIDERS — tambahkan browser resolver kalau Playwright tersedia
(function initProviders() {
  if (_hasPlaywright()) {
    PROVIDERS.push({ name: 'browser', fn: resolveViaBrowser });
  }
})();

/**
 * Resolve share Terabox via provider gratis (urut). Return provider pertama yang sukses.
 * Provider yang return file tapi SEMUA tanpa directLink akan di-skip —
 * supaya browser provider (Playwright) tetap bisa dicoba.
 * @returns {{files: Array, source: string}}
 * @throws {Error} kalau semua provider gagal
 */
async function resolve(teraboxUrl) {
  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const files = await p.fn(teraboxUrl);
      // Skip provider kalau semua file tidak punya directLink —
      // kasus umum: direct scraper sukses list file dari SPA tapi tanpa dlink (no cookies).
      const hasLink = files.some(f => f.directLink);
      if (!hasLink) {
        errors.push(`${p.name}: file ter-listing tapi tidak ada direct download link (butuh cookies/browser)`);
        continue;
      }
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
