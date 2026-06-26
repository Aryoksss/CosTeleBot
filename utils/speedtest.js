'use strict';

/**
 * Speedtest jaringan VPS via endpoint Cloudflare (speed.cloudflare.com).
 * Ukur: ping (latency), download Mbps, upload Mbps. Dipakai dari dashboard on-demand.
 * Zero-dep tambahan: pakai axios yang sudah ada.
 */

const axios = require('axios');

const DOWN_URL = (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;
const UP_URL = 'https://speed.cloudflare.com/__up';
const UA = 'CosTeleBot-Speedtest/1.0';

/** Ukur latency rata-rata (ms) dari beberapa request kecil. */
async function measurePing(samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      await axios.get(DOWN_URL(0), { headers: { 'User-Agent': UA }, timeout: 8000, validateStatus: () => true });
      times.push(Date.now() - t0);
    } catch (_) { }
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  const best = times.slice(0, Math.max(1, times.length - 1)); // buang outlier terburuk
  const avg = best.reduce((a, b) => a + b, 0) / best.length;
  return { avgMs: Math.round(avg), minMs: times[0], samples: times.length };
}

/** Download `bytes` byte, return Mbps + detik. */
async function measureDownload(bytes) {
  const t0 = Date.now();
  let received = 0;
  const res = await axios.get(DOWN_URL(bytes), {
    headers: { 'User-Agent': UA },
    responseType: 'stream',
    timeout: 60000,
    validateStatus: () => true,
  });
  await new Promise((resolve, reject) => {
    res.data.on('data', c => { received += c.length; });
    res.data.on('end', resolve);
    res.data.on('error', reject);
  });
  const sec = (Date.now() - t0) / 1000;
  return { bytes: received, sec, mbps: sec > 0 ? (received * 8) / sec / 1e6 : 0 };
}

/** Upload `bytes` byte random, return Mbps + detik. */
async function measureUpload(bytes) {
  const buf = Buffer.alloc(bytes, 0x61); // 'a' repeated; konten tidak penting
  const t0 = Date.now();
  await axios.post(UP_URL, buf, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/octet-stream' },
    timeout: 60000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  const sec = (Date.now() - t0) / 1000;
  return { bytes, sec, mbps: sec > 0 ? (bytes * 8) / sec / 1e6 : 0 };
}

/**
 * Jalankan speedtest lengkap. Ukuran adaptif: mulai kecil, naikkan kalau cepat.
 * Return { pingMs, minMs, downMbps, upMbps, downMB, upMB, server, took }.
 */
async function run() {
  const startedAt = Date.now();
  const result = { ok: true, server: 'Cloudflare', pingMs: null, minMs: null, downMbps: 0, upMbps: 0, downMB: 0, upMB: 0 };
  try {
    const ping = await measurePing(5);
    if (ping) { result.pingMs = ping.avgMs; result.minMs = ping.minMs; }

    // Download: warm-up 10MB; kalau <2s (cepat) ulangi 50MB untuk akurasi.
    let d = await measureDownload(10 * 1024 * 1024);
    if (d.sec < 2) d = await measureDownload(50 * 1024 * 1024);
    result.downMbps = +d.mbps.toFixed(1);
    result.downMB = +(d.bytes / 1048576).toFixed(1);

    // Upload: 10MB (cukup untuk estimasi; banyak VPS upload lebih lambat).
    try {
      const u = await measureUpload(10 * 1024 * 1024);
      result.upMbps = +u.mbps.toFixed(1);
      result.upMB = +(u.bytes / 1048576).toFixed(1);
    } catch (e) { result.upError = e.message; }

    result.took = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
    return result;
  } catch (e) {
    return { ok: false, error: e.message, took: ((Date.now() - startedAt) / 1000).toFixed(1) + 's' };
  }
}

module.exports = { run, measurePing, measureDownload, measureUpload };
