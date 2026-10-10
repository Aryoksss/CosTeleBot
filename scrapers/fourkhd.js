'use strict';

/**
 * 4KHD scraper — PURE AXIOS (tanpa Playwright).
 *
 * 4khd.com = situs galeri foto (WordPress). Beda dari cosplaytele: TIDAK ada link
 * download eksternal (gofile/terabox) — foto disajikan langsung sebagai galeri.
 *
 * Strategi:
 *   - Listing/search  : HTML page (`/?s=query`, homepage) → parse <li.wp-block-post>.
 *                       (REST list endpoint diblok 403, jadi pakai HTML.)
 *   - Detail (semua foto): halaman HTML awal cuma load ~20 foto (lazy-load JS). Ambil
 *                       postId dari referensi `wp-json/wp/v2/posts/<id>` di HTML, lalu
 *                       fetch single-post REST (200 OK) → content.rendered berisi SEMUA
 *                       URL foto. Fallback: parse <img> dari HTML kalau REST gagal.
 *
 * Foto di-host di pic.4khd.com via proxy i0.wp.com, resolusi w1300.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.4khd.com';
const UA = require('../utils/ua').UA;

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const client = axios.create({
  headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${BASE}/`,
  },
  timeout: 25000,
  validateStatus: () => true,
});

/** Parse halaman listing → array post {url, title, thumb, size, photoCount}. */
function parseListing(html) {
  const $ = cheerio.load(html);
  const posts = [];
  const seen = new Set();
  $('li.wp-block-post, .post').each((_, el) => {
    const a = $(el).find('h2 a, h3 a, .entry-title a').first();
    const href = a.attr('href');
    if (!href || seen.has(href) || !/\/content\//.test(href)) return;
    seen.add(href);
    const rawTitle = a.text().trim();
    const img = $(el).find('figure img, img').first();
    const thumb = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src');
    // "[38MB-43photos]" / "[2.14GB-81photos]"
    const meta = rawTitle.match(/\[([\d.]+\s*[KMGT]?B)[-\s]*(\d+)\s*photos?\]/i);
    posts.push({
      url: href,
      title: rawTitle.replace(/\[[^\]]*\]\s*$/, '').trim() || rawTitle,
      thumb: thumb ? thumb.split('?')[0] : null,
      size: meta ? meta[1] : null,
      photoCount: meta ? parseInt(meta[2], 10) : null,
    });
  });
  return posts;
}

/**
 * Cari post via kata kunci.
 * PENTING: 4khd punya 2 mekanisme pagination BERBEDA (WordPress Query Loop block):
 *   - Search  : path-based → /search/<query>/page/<N>  (classic WP pagination)
 *   - Latest  : query-param → /?query-3-page=<N>        (Gutenberg Query block ID #3)
 * Format lama `/page/N/?s=query` SELALU balik ke halaman 1 (parameter diabaikan situs),
 * jadi gacha/reroll collision tinggi karena pool-nya cuma 1 halaman berulang.
 */
async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return [];
  const url = page > 1
    ? `${BASE}/search/${encodeURIComponent(query)}/page/${page}`
    : `${BASE}/?s=${encodeURIComponent(query)}`;
  log.info(`[4KHD] search "${query}" page=${page}`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[4KHD] search HTTP ${r.status}`); return []; }
    const posts = parseListing(r.data);
    log.info(`[4KHD] search → ${posts.length} posts`);
    return posts;
  } catch (e) { log.error(`[4KHD] search error: ${e.message}`); return []; }
}

/** Post terbaru (homepage / paginated via Gutenberg Query Loop block ?query-3-page=N). */
async function scrapeLatest(page = 1) {
  const url = page > 1 ? `${BASE}/?query-3-page=${page}` : `${BASE}/`;
  log.info(`[4KHD] latest page=${page}`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[4KHD] latest HTTP ${r.status}`); return []; }
    return parseListing(r.data);
  } catch (e) { log.error(`[4KHD] latest error: ${e.message}`); return []; }
}

/** Ekstrak semua URL foto dari content.rendered / HTML (dedup + urut nomor). */
function extractPhotos(content) {
  const raw = (content.match(/https?:\/\/[^\s"'<>\\]*pic\.4khd\.com[^\s"'<>\\)]*/gi) || [])
    .map(u => u.replace(/\\\//g, '/'));
  const byNum = new Map();
  const noNum = [];
  for (const u of raw) {
    if (!/\.(webp|jpg|jpeg|png)/i.test(u)) continue;
    const clean = u.split('?')[0];
    const n = (u.match(/-(\d{2,4})\.(webp|jpg|jpeg|png)/i) || [])[1];
    if (n) { if (!byNum.has(n)) byNum.set(n, clean); }
    else if (!noNum.includes(clean)) noNum.push(clean);
  }
  const numbered = [...byNum.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(e => e[1]);
  return numbered.length ? numbered : noNum;
}

/** Detail post → { title, postId, images: [url...] , photoCount }. */
async function scrapePostDetail(postUrl) {
  log.info(`[4KHD] detail ${postUrl}`);
  try {
    const r = await client.get(postUrl);
    if (r.status !== 200) { log.warn(`[4KHD] detail HTTP ${r.status}`); return null; }
    const html = String(r.data);
    const $ = cheerio.load(html);
    const title = ($('title').text() || '').replace(/\s*-\s*4KHD.*$/i, '').replace(/\[[^\]]*\]\s*$/, '').trim();
    const postId = (html.match(/wp-json\/wp\/v2\/posts\/(\d+)/) || [])[1];

    let images = [];
    if (postId) {
      try {
        const rest = await client.get(`${BASE}/wp-json/wp/v2/posts/${postId}`, { headers: { 'Accept': 'application/json' } });
        if (rest.status === 200 && rest.data && rest.data.content && rest.data.content.rendered) {
          images = extractPhotos(rest.data.content.rendered);
        }
      } catch (e) { log.warn(`[4KHD] REST fetch gagal: ${e.message}`); }
    }
    // Fallback: parse <img> dari HTML (biasanya cuma ~20 foto pertama).
    if (!images.length) {
      const s = new Set();
      $('img').each((_, el) => {
        const u = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
        if (u && /pic\.4khd\.com/i.test(u) && /-\d{2,4}\.(webp|jpg|jpeg|png)/i.test(u)) s.add(u.split('?')[0]);
      });
      images = [...s];
    }
    log.info(`[4KHD] detail "${title.slice(0, 40)}" → ${images.length} foto`);
    return { title, postId, images, photoCount: images.length };
  } catch (e) { log.error(`[4KHD] detail error: ${e.message}`); return null; }
}

/**
 * Gacha: ambil post acak dari homepage. Situs punya ribuan halaman (~3000+), jadi
 * rentang random dilebarkan jauh (1-500) untuk pool yang benar-benar beragam —
 * sebelumnya cuma 1-15 karena keliru pakai format pagination yang tidak berfungsi.
 */
async function scrapeGacha() {
  const page = Math.floor(Math.random() * 500) + 1;
  const posts = await scrapeLatest(page);
  return posts;
}

module.exports = { scrapeSearch, scrapeLatest, scrapePostDetail, scrapeGacha, parseListing, extractPhotos };
