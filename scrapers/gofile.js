'use strict';

/**
 * Gofile resolver & downloader — PURE AXIOS (tanpa Playwright/Chromium).
 *
 * Alur (meniru yang dilakukan browser, tanpa browser):
 *   1. POST https://api.gofile.io/accounts        → guest account token (Bearer)
 *   2. Hitung "website token" (wt) dengan menjalankan dist/js/wt.obf.js di VM
 *      sandbox lalu memanggil generateWT(). wt rotasi → di-cache 1 jam, fallback
 *      ke token statik bila gagal.
 *   3. GET https://api.gofile.io/contents/{id}     dengan header
 *      Authorization: Bearer <token> + X-Website-Token: <wt> (+ query wt).
 *      Descend rekursif kalau child-nya folder.
 *
 * Proxy: gofile.io & api.gofile.io kadang block IP datacenter (DO/AWS/GCP).
 * Set GOFILE_PROXY=socks5://127.0.0.1:40000 (Cloudflare WARP) → dipakai HANYA untuk
 * request resolve di atas. Download CDN (store*.gofile.io) tetap langsung dari VPS.
 *
 * Kompatibel dengan kontrak lama:
 *   resolveGofile(url)  → { files: [{id, name, link}], cookie:'', accountToken }
 *   downloadGofileFile(directUrl, destPath, onProgress, accountToken) → Promise<number>
 */

const axios = require('axios');
const vm = require('vm');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API = 'https://api.gofile.io';
const WEB = 'https://gofile.io';
const STATIC_WT = '4fd6sg89d7s6'; // fallback dari dist/js/config.js (bisa stale)

const log = {
  info: (m) => console.log(`\x1b[36m[Gofile]\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m[Gofile]\x1b[0m ${m}`),
  err: (m) => console.error(`\x1b[31m[Gofile]\x1b[0m ${m}`),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Proxy (opsional, untuk request resolve saja) ─────────────────────────────
function getProxyAgent() {
  const raw = process.env.GOFILE_PROXY || process.env.HTTPS_PROXY || '';
  if (!raw) return null;
  try {
    if (/^socks/i.test(raw)) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(raw);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(raw);
  } catch (e) {
    log.warn(`proxy agent gagal dibuat (${e.message}), lanjut tanpa proxy`);
    return null;
  }
}

function resolveAxiosCfg(extra = {}) {
  const agent = getProxyAgent();
  const cfg = {
    headers: { 'User-Agent': UA, 'Origin': WEB, 'Referer': `${WEB}/`, 'Accept': 'application/json, text/plain, */*', ...(extra.headers || {}) },
    timeout: extra.timeout || 20000,
    validateStatus: () => true,
  };
  if (agent) { cfg.httpAgent = agent; cfg.httpsAgent = agent; }
  return { ...cfg, ...extra, headers: cfg.headers };
}

// ─── Website token (wt) via VM sandbox ────────────────────────────────────────
let _wtCache = { value: null, expires: 0 };

/** Jalankan wt.obf.js di sandbox aman, panggil generateWT(). Return string atau null. */
function runGenerateWT(code) {
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined, construct: () => ({}) });
  const readyHandlers = [];
  const base = {
    appdata: {}, console: { log: () => {}, warn: () => {}, error: () => {} },
    navigator: { userAgent: UA, platform: 'Win32', language: 'en-US' },
    location: { href: `${WEB}/`, hostname: 'gofile.io', protocol: 'https:', pathname: '/', host: 'gofile.io' },
    parseInt, parseFloat, String, Number, Array, Object, JSON, Math, Date, RegExp, Boolean, isNaN,
    encodeURIComponent, decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    document: {
      addEventListener: (e, cb) => { if (e === 'DOMContentLoaded') readyHandlers.push(cb); },
      querySelector: () => null, querySelectorAll: () => [], cookie: '', readyState: 'complete',
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
      getElementById: () => null, body: {}, head: {},
    },
  };
  const host = new Proxy(base, {
    has: () => true,
    get(t, k) {
      if (k in t) return t[k];
      if (['window', 'self', 'globalThis', 'top', 'parent'].includes(k)) return host;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  base.window = host; base.self = host; base.globalThis = host;

  vm.createContext(host);
  vm.runInContext(code, host, { timeout: 5000 });
  for (const cb of readyHandlers) { try { cb({}); } catch (_) {} }

  // generateWT() jadi global setelah eksekusi
  if (typeof base.generateWT === 'function') {
    const wt = base.generateWT();
    if (typeof wt === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(wt)) return wt;
  }
  // fallback: kalau script set appdata.wt
  if (base.appdata && typeof base.appdata.wt === 'string' && base.appdata.wt) return base.appdata.wt;
  return null;
}

async function getWebsiteToken() {
  if (_wtCache.value && Date.now() < _wtCache.expires) return _wtCache.value;
  try {
    const res = await axios.get(`${WEB}/dist/js/wt.obf.js`, resolveAxiosCfg({
      headers: { 'User-Agent': UA, 'Referer': `${WEB}/` }, timeout: 15000,
    }));
    if (res.status === 200 && res.data) {
      const wt = runGenerateWT(String(res.data));
      if (wt) {
        _wtCache = { value: wt, expires: Date.now() + 60 * 60 * 1000 };
        log.info(`website token resolved (${wt.length} chars)`);
        return wt;
      }
      log.warn('generateWT tidak menghasilkan token valid, pakai STATIC_WT');
    } else {
      log.warn(`wt.obf.js HTTP ${res.status}, pakai STATIC_WT`);
    }
  } catch (e) {
    log.warn(`gagal ambil wt.obf.js (${e.message}), pakai STATIC_WT`);
  }
  return STATIC_WT;
}

// ─── Guest account token ──────────────────────────────────────────────────────
async function getGuestToken() {
  const MAX = 4;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const res = await axios.post(`${API}/accounts`, '{}', resolveAxiosCfg({
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Origin': WEB, 'Referer': `${WEB}/` },
      timeout: 15000,
    }));
    if (res.status === 200 && res.data?.data?.token) return res.data.data.token;
    if (res.status === 429 || res.data?.status === 'error-rateLimit') {
      const backoff = Math.min(attempt * 4000, 15000);
      log.warn(`accounts rate-limit (attempt ${attempt}/${MAX}), tunggu ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    log.warn(`accounts HTTP ${res.status} status=${res.data?.status}`);
    if (attempt < MAX) { await sleep(attempt * 2000); continue; }
  }
  return null;
}

// ─── Contents (rekursif descend folder) ───────────────────────────────────────
async function fetchContents(contentId, token, wt, depth = 0) {
  const res = await axios.get(`${API}/contents/${contentId}`, resolveAxiosCfg({
    params: { wt, cache: true },
    headers: { 'User-Agent': UA, 'Authorization': `Bearer ${token}`, 'X-Website-Token': wt, 'Referer': `${WEB}/` },
    timeout: 20000,
  }));

  if (res.status !== 200 || res.data?.status !== 'ok') {
    return { ok: false, status: res.data?.status || `HTTP ${res.status}`, files: [] };
  }

  const data = res.data.data;
  const files = [];
  const children = data?.children || {};
  for (const childId in children) {
    const c = children[childId];
    if (!c) continue;
    if (c.type === 'folder' && depth < 3) {
      // Descend folder anak
      const sub = await fetchContents(c.id || childId, token, wt, depth + 1);
      if (sub.ok) files.push(...sub.files);
    } else if (c.link) {
      files.push({ id: childId, name: c.name || 'archive.bin', link: c.link, size: c.size || 0 });
    }
  }
  return { ok: true, status: 'ok', files };
}

function extractContentId(gofileUrl) {
  const clean = gofileUrl.split('#')[0];
  const m = clean.match(/\/d\/([\w-]+)/);
  if (m) return m[1];
  return clean.split('/').filter(Boolean).pop();
}

/**
 * Resolve isi link Gofile → daftar file + direct CDN link.
 * @returns {Promise<{files:Array<{id,name,link,size}>, cookie:string, accountToken:string}|null>}
 */
async function resolveGofile(gofileUrl) {
  const proxy = getProxyAgent();
  log.info(`resolveGofile START ${gofileUrl.split('#')[0]} proxy=${proxy ? 'on' : 'none'}`);
  try {
    const contentId = extractContentId(gofileUrl);
    if (!contentId) { log.warn('content id tidak terbaca dari URL'); return null; }

    const token = await getGuestToken();
    if (!token) { log.err('gagal dapat guest token (rate-limit?)'); return null; }

    const wt = await getWebsiteToken();
    let result = await fetchContents(contentId, token, wt);

    // Kalau wt cache stale (error-notPremium / error-wrongToken), refresh sekali.
    if (!result.ok && /notPremium|wrongToken|websiteToken|auth/i.test(result.status)) {
      log.warn(`contents gagal (${result.status}), refresh website token...`);
      _wtCache = { value: null, expires: 0 };
      const wt2 = await getWebsiteToken();
      if (wt2 !== wt) result = await fetchContents(contentId, token, wt2);
    }

    if (!result.ok) { log.warn(`contents gagal: ${result.status}`); return null; }
    log.info(`resolveGofile OK → ${result.files.length} file`);
    return { files: result.files, cookie: '', accountToken: token };
  } catch (err) {
    log.err(`resolve error: ${err.message}`);
    return null;
  } finally {
    log.info('resolveGofile END');
  }
}

/**
 * Download file Gofile via axios streaming (tidak buffer ke RAM — aman untuk file 1GB+).
 * Gofile CDN butuh `Authorization: Bearer <accountToken>` dari resolveGofile().
 *
 * @param {string}   directUrl    direct link (store*.gofile.io/...)
 * @param {string}   destPath     path tujuan
 * @param {function} [onProgress] (downloadedBytes, totalBytes) => void (~tiap 1 detik)
 * @param {string}   [accountToken] token dari resolveGofile().accountToken
 * @returns {Promise<number>}   ukuran file akhir (byte)
 */
async function downloadGofileFile(directUrl, destPath, onProgress = null, accountToken = null) {
  log.info(`DL START url=${directUrl.slice(0, 80)}...`);

  if (!accountToken) {
    // Fallback: fetch guest token baru (pure axios, tanpa browser).
    log.info('accountToken tidak di-forward, fetch guest token baru...');
    accountToken = await getGuestToken();
  }
  log.info(`accountToken: ${accountToken ? '***(' + accountToken.length + ' chars)' : 'NONE'}`);

  const reqCfg = {
    method: 'GET',
    url: directUrl,
    responseType: 'stream',
    timeout: 3600000, // 1 jam untuk file raksasa
    headers: {
      'User-Agent': UA,
      'Referer': `${WEB}/`,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': accountToken ? `accountToken=${accountToken}` : '',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  };
  if (accountToken) reqCfg.headers['Authorization'] = `Bearer ${accountToken}`;
  // CDN download langsung dari VPS (tanpa proxy) — lebih stabil untuk file besar.

  const MAX_RETRIES = 3;
  let res = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await axios(reqCfg);
      const status = res.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable) break;

      let bodyPreview = '';
      try {
        const chunks = [];
        for await (const c of res.data) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 500) break; }
        bodyPreview = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
      } catch (_) { }
      log.warn(`DL attempt ${attempt}/${MAX_RETRIES} → HTTP ${status} body="${bodyPreview}"`);

      if (attempt === MAX_RETRIES) {
        throw new Error(`Gofile CDN HTTP ${status} setelah ${MAX_RETRIES} retry: ${bodyPreview || '(empty)'}`);
      }
      const retryAfter = parseInt(res.headers['retry-after'] || '0', 10);
      const backoff = retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : Math.pow(2, attempt) * 3000;
      log.info(`DL retry dalam ${backoff}ms...`);
      await sleep(backoff);
    } catch (e) {
      if (e.message && e.message.startsWith('Gofile CDN HTTP')) throw e;
      if (attempt === MAX_RETRIES) throw e;
      log.warn(`DL attempt ${attempt} network error: ${e.message}, retry...`);
      await sleep(Math.pow(2, attempt) * 2000);
    }
  }

  const status = res.status;
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  const total = parseInt(res.headers['content-length'] || '0', 10);
  log.info(`DL response status=${status} ct=${ct} len=${total} (${(total / 1048576).toFixed(1)}MB)`);

  if (status !== 200) {
    try { res.data.destroy(); } catch (_) { }
    throw new Error(`Gofile CDN HTTP ${status}`);
  }
  if (ct.startsWith('text/html') || ct.startsWith('text/plain')) {
    let body = '';
    try {
      const chunks = [];
      for await (const c of res.data) chunks.push(c);
      body = Buffer.concat(chunks).toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
    } catch (_) { }
    throw new Error(`Gofile CDN balas ${ct} (bukan binary). Body: ${body || '(empty)'}. Mungkin link expired, rate-limit, atau token salah.`);
  }

  // Stream ke disk + progress + resume (Range) max 3x.
  const RESUME_MAX = 3;
  let resumeAttempt = 0;
  let totalDownloaded = 0;

  while (true) {
    const size = await new Promise((resolve, reject) => {
      const writeOpts = totalDownloaded > 0 ? { flags: 'a' } : undefined;
      const writer = fs.createWriteStream(destPath, writeOpts);
      let lastTick = Date.now();

      res.data.on('data', (chunk) => {
        totalDownloaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastTick >= 1000) { onProgress(totalDownloaded, total); lastTick = now; }
      });
      res.data.on('error', (err) => {
        writer.close();
        reject(new Error(`Stream abort: ${err.message} (downloaded ${(totalDownloaded / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`));
      });
      writer.on('error', (err) => {
        try { res.data.destroy(); } catch (_) { }
        reject(new Error(`Write error: ${err.message}`));
      });
      writer.on('finish', () => {
        if (onProgress) onProgress(totalDownloaded, total);
        const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        log.info(`DL END size=${(fileSize / 1048576).toFixed(1)}MB`);
        resolve(fileSize);
      });
      res.data.pipe(writer);
    }).catch(async (err) => {
      resumeAttempt++;
      if (resumeAttempt > RESUME_MAX || totalDownloaded === 0) {
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
        throw err;
      }
      log.warn(`Stream aborted at ${(totalDownloaded / 1048576).toFixed(1)}MB, resume ${resumeAttempt}/${RESUME_MAX}...`);
      await sleep(3000 * resumeAttempt);
      const resumeCfg = { ...reqCfg, headers: { ...reqCfg.headers, 'Range': `bytes=${totalDownloaded}-` } };
      try {
        res = await axios(resumeCfg);
        if (res.status !== 206 && res.status !== 200) throw new Error(`Resume failed: HTTP ${res.status}`);
        log.info(`Resume OK from byte ${totalDownloaded}, status=${res.status}`);
        return null;
      } catch (resumeErr) {
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
        throw new Error(`Resume failed: ${resumeErr.message}`);
      }
    });

    if (size !== null) return size;
  }
}

module.exports = {
  resolveGofile,
  downloadGofileFile,
  // diekspor untuk testing/tools
  getGuestToken,
  getWebsiteToken,
};
