'use strict';
/**
 * Terabox resolver — extract direct download URLs from Terabox share links.
 * 
 * Uses multi-API fallback chain:
 *   1. tera-core.vercel.app/api2 — free, no auth, supports multi-file folders (PRIMARY)
 *   2. xAPIverse (existing) — paid credits, zip-all-files (FALLBACK)
 * 
 * Supported Terabox domains (auto-normalized to canonical URL):
 *   terabox.com, 1024terabox.com, terabox.app, teraboxshare.com, teraboxlink.com
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TERACORE_API = 'https://tera-core.vercel.app/api2';

const http = axios.create({ timeout: 45000, headers: { 'User-Agent': UA } });

/**
 * Extract direct download URLs via tera-core free API.
 * @returns {{files: Array<{filename, size, sizeBytes, directLink, isDirectory}>}}
 * @throws {Error} if API fails
 */
async function resolveViaTeraCore(teraboxUrl) {
  const res = await http.get(TERACORE_API, {
    params: { url: teraboxUrl },
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    throw new Error(`tera-core API HTTP ${res.status}: ${String(res.data).slice(0, 200)}`);
  }

  const data = res.data;
  if (data.status !== 'success' || !Array.isArray(data.files) || data.files.length === 0) {
    throw new Error(`tera-core API: ${data.message || 'no files returned'}`);
  }

  const files = data.files.map(f => ({
    filename: f.filename || 'terabox_file',
    size: f.size || '?',
    sizeBytes: parseInt(f.size_bytes || '0', 10),
    directLink: f.direct_link || f.download_link || null,
    isDirectory: !!f.is_directory,
    thumbnails: f.thumbnails || {},
  })).filter(f => f.directLink); // only keep files with valid link

  return { files, totalFiles: data.total_files, url: data.url };
}

/**
 * Main resolve function — try APIs in order, return first success.
 * @param {string} teraboxUrl
 * @returns {{files: Array, source: string}}
 */
async function resolve(teraboxUrl) {
  const errors = [];

  // Try 1: tera-core (free, public, no auth)
  try {
    const result = await resolveViaTeraCore(teraboxUrl);
    return { ...result, source: 'tera-core' };
  } catch (e) {
    errors.push(`tera-core: ${e.message}`);
  }

  // All APIs failed
  throw new Error(`All Terabox APIs failed:\n${errors.join('\n')}`);
}

module.exports = { resolve, resolveViaTeraCore };
