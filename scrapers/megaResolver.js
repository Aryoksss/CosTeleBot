'use strict';
/**
 * Mega.nz resolver + streaming downloader.
 * Uses megajs library to handle Mega's client-side encryption.
 *
 * Authentication:
 *   - Anonymous (default): kena quota global Mega yang di-share semua user IP, sering kena limit
 *   - Login (optional, set env MEGA_EMAIL + MEGA_PASSWORD): quota per-akun (20GB/bulan free tier)
 *
 * Supports:
 *   - Direct Mega links: https://mega.nz/file/XXX#KEY or https://mega.nz/#!XXX!KEY
 *   - Redirector links: https://link.desustream.com/?id=... (follows 302)
 */

// Polyfill crypto.subtle untuk Node < 19 (megajs butuh Web Crypto API)
if (!globalThis.crypto) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
} else if (!globalThis.crypto.subtle) {
  const { webcrypto } = require('crypto');
  globalThis.crypto.subtle = webcrypto.subtle;
}

const axios = require('axios');

// SOCKS5 proxy support (bypass Mega IP throttle di datacenter).
// Reuse GOFILE_PROXY atau set MEGA_PROXY terpisah. Di-cache karena login Mega berumur panjang.
const getProxyAgent = require('../utils/proxy').createProxyAgent(
  ['MEGA_PROXY', 'GOFILE_PROXY'],
  { cache: true }
);

// megajs package — lazy-required supaya bot tidak crash kalau package missing
let megajs = null;
function getMegajs() {
  if (!megajs) {
    try {
      megajs = require('megajs');
    } catch (e) {
      throw new Error('Package megajs belum ter-install. Jalankan: npm install megajs');
    }
  }
  return megajs;
}

// Cache login session — hanya login sekali per-restart bot, reuse storage.api untuk semua download
let _loggedStorage = null;
let _loginPromise = null;

async function getLoggedStorage() {
  if (_loggedStorage) return _loggedStorage;
  if (_loginPromise) return _loginPromise; // concurrent login attempt → share promise

  const email = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;
  if (!email || !password) return null; // no credentials → anonymous mode

  const { Storage } = getMegajs();
  const agent = getProxyAgent();

  _loginPromise = new Promise((resolve, reject) => {
    // Pass agent in constructor options so login itself goes through proxy
    const opts = { email, password, userAgent: UA };
    if (agent) {
      opts.httpAgent = agent;
      opts.httpsAgent = agent;
    }
    const storage = new Storage(opts, (err) => {
      if (err) {
        console.error(`\x1b[31m[ERROR]\x1b[0m [Mega] Login gagal: ${err.message}`);
        _loginPromise = null;
        return reject(err);
      }
      // Ensure agent persists on api object for download calls
      if (agent) {
        storage.api.httpAgent = agent;
        storage.api.httpsAgent = agent;
        console.log(`\x1b[32m[OK]\x1b[0m    [Mega] Proxy aktif: ${process.env.MEGA_PROXY || process.env.GOFILE_PROXY}`);
      }
      console.log(`\x1b[32m[OK]\x1b[0m    [Mega] Login berhasil sebagai ${email}`);
      _loggedStorage = storage;
      resolve(storage);
    });
  });

  try {
    return await _loginPromise;
  } catch (_) {
    _loginPromise = null;
    return null;
  }
}

const UA = require('../utils/ua').UA;

/**
 * Resolve redirector URL (link.desustream.com) to final Mega URL via 302 redirect.
 * If input is already a Mega URL, return as-is.
 */
async function resolveRedirector(url) {
  if (url.includes('mega.nz') || url.includes('mega.co.nz')) return url;

  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      timeout: 15000,
      headers: { 'User-Agent': UA },
    });
    const loc = res.headers['location'];
    if (loc && (loc.includes('mega.nz') || loc.includes('mega.co.nz'))) return loc;
    return null;
  } catch (err) {
    if (err.response) {
      const loc = err.response.headers['location'];
      if (loc && (loc.includes('mega.nz') || loc.includes('mega.co.nz'))) return loc;
    }
    return null;
  }
}

/**
 * Create a File object using logged API (if credentials set) or anonymous.
 * Proxy applied in both cases.
 */
async function createFile(megaUrl) {
  const { File, API } = getMegajs();
  const agent = getProxyAgent();

  const storage = await getLoggedStorage();
  if (storage) {
    // Ensure agent is still set (in case it was cleared)
    if (agent) {
      storage.api.httpAgent = agent;
      storage.api.httpsAgent = agent;
    }
    return File.fromURL(megaUrl, { api: storage.api });
  }

  // Anonymous mode — apply proxy if available
  const file = File.fromURL(megaUrl);
  file.api.userAgent = UA;
  if (agent) {
    file.api.httpAgent = agent;
    file.api.httpsAgent = agent;
  }
  return file;
}

/**
 * Get metadata (name + size) for a Mega shared link.
 * @returns {{name, size}}
 */
async function getInfo(megaUrl) {
  const resolvedUrl = await resolveRedirector(megaUrl) || megaUrl;
  const file = await createFile(resolvedUrl);
  await file.loadAttributes();
  return { name: file.name, size: file.size, file };
}

/**
 * Download Mega file to destination path with progress callback.
 * @param {string} megaUrl - Mega or redirector URL
 * @param {string} destPath - local file path to save to
 * @param {function(pct, speed, eta)} onProgress - progress callback
 */
async function downloadMega(megaUrl, destPath, onProgress) {
  const fs = require('fs');

  const resolvedUrl = await resolveRedirector(megaUrl) || megaUrl;
  const file = await createFile(resolvedUrl);
  await file.loadAttributes();

  const totalSize = file.size;
  let downloaded = 0;
  const startTime = Date.now();
  const agent = getProxyAgent();
  const proxyInfo = agent ? `via proxy ${process.env.MEGA_PROXY || process.env.GOFILE_PROXY}` : 'direct (no proxy)';
  console.log(`\x1b[36m[INFO]\x1b[0m  [Mega] Download start: ${file.name} (${(totalSize/1024/1024).toFixed(1)} MB) ${proxyInfo}`);

  return new Promise((resolve, reject) => {
    const stream = file.download();
    const writeStream = fs.createWriteStream(destPath);

    stream.on('data', (chunk) => {
      downloaded += chunk.length;
      if (onProgress && totalSize > 0) {
        const pct = (downloaded / totalSize) * 100;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? downloaded / elapsed : 0; // bytes/sec
        const eta = speed > 0 ? (totalSize - downloaded) / speed : 0;
        onProgress(pct, speed, eta);
      }
    });

    stream.on('error', (err) => {
      try { writeStream.close(); } catch (_) {}
      reject(err);
    });

    writeStream.on('error', (err) => {
      try { stream.destroy(); } catch (_) {}
      reject(err);
    });

    writeStream.on('finish', () => resolve({ name: file.name, size: totalSize, path: destPath }));

    stream.pipe(writeStream);
  });
}

/**
 * Check if logged-in (for health check display).
 */
function isLoggedIn() {
  return !!_loggedStorage;
}

module.exports = { getInfo, downloadMega, resolveRedirector, isLoggedIn };
