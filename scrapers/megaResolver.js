'use strict';
/**
 * Mega.nz resolver + streaming downloader.
 * Uses megajs library to handle Mega's client-side encryption.
 *
 * Supports:
 *   - Direct Mega links: https://mega.nz/file/XXX#KEY or https://mega.nz/#!XXX!KEY
 *   - Redirector links: https://link.desustream.com/?id=... (follows 302)
 */

const axios = require('axios');

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

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
 * Get metadata (name + size) for a Mega shared link.
 * @returns {{name, size}}
 */
async function getInfo(megaUrl) {
  const { File } = getMegajs();
  const resolvedUrl = await resolveRedirector(megaUrl) || megaUrl;
  const file = File.fromURL(resolvedUrl);
  file.api.userAgent = 'CosTeleBot/1.0';
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
  const { File } = getMegajs();

  const resolvedUrl = await resolveRedirector(megaUrl) || megaUrl;
  const file = File.fromURL(resolvedUrl);
  file.api.userAgent = 'CosTeleBot/1.0';
  await file.loadAttributes();

  const totalSize = file.size;
  let downloaded = 0;
  const startTime = Date.now();

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

module.exports = { getInfo, downloadMega, resolveRedirector };
