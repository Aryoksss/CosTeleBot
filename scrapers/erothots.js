/**
 * EroThots scraper (pure axios — no Playwright).
 *
 * erothots.co serves standard HTML, zero Cloudflare challenge.
 * Search URL: /search/<query> → page 1 dengan hasil search-relevan (30-ish item).
 * Page 2+ (/search/<query>/<N>) kembalikan mixed recent videos (bukan filter query),
 * jadi kita batasi ke page 1 saja untuk hasil yang benar-benar relevan.
 *
 * Listing selector: a.video-media (anchor itself)
 * Detail: <source type="video/mp4" src="..."> directly in HTML
 *
 * Output:
 *   listing: [{ id, title, link, thumb, durationText }]
 *   detail:  { title, thumb, videoUrl }
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://erothots.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const client = axios.create({
  headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
  },
  timeout: 20000,
  maxRedirects: 5,
  validateStatus: () => true,
});

function extractVideoId(href) {
  // Pattern: /video/<id>/<slug>/
  const m = href.match(/\/video\/([^/]+)\//);
  return m ? m[1] : null;
}

function parseListingHTML(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('a.video-media').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || !href.includes('/video/') || seen.has(href)) return;
    seen.add(href);

    const id = extractVideoId(href);
    if (!id) return;

    const img = $(el).find('img').first();
    // Thumbnail: lazy-loaded (src is placeholder base64, real URL at data-src)
    const thumb = img.attr('data-src') || img.attr('src');
    const title = img.attr('alt') || $(el).find('.title, h3').first().text().trim() || 'Untitled';

    // Duration in <span class="caption">
    const duration = $(el).find('.caption').first().text().trim();

    items.push({
      id,
      title: title.slice(0, 200),
      link: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      thumb: thumb && thumb.startsWith('http') ? thumb : null,
      durationText: duration,
    });
  });

  return items;
}

/**
 * Search video di EroThots.
 * @param {string} query
 * @param {number} page  default 1. Page >1 biasanya tidak search-relevan lagi.
 * @returns {Promise<{items, hasNext}>}
 */
async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return { items: [], hasNext: false };
  const url = page > 1
    ? `${BASE_URL}/search/${encodeURIComponent(query)}/${page}`
    : `${BASE_URL}/search/${encodeURIComponent(query)}`;
  log.info(`[EroThots] search "${query}" page=${page}`);

  try {
    const r = await client.get(url);
    if (r.status !== 200) {
      log.warn(`[EroThots] search HTTP ${r.status}`);
      return { items: [], hasNext: false };
    }
    const items = parseListingHTML(r.data);
    // Heuristic hasNext: kalau return ≥ 30 item di page pertama, coba page kedua.
    // Page 2+ biasanya return hasil generic — kita flag hasNext=false dari page 2.
    const hasNext = page === 1 && items.length >= 30;
    log.info(`[EroThots] → ${items.length} items (next=${hasNext})`);
    return { items, hasNext };
  } catch (e) {
    log.error(`[EroThots] search error: ${e.message}`);
    return { items: [], hasNext: false };
  }
}

/**
 * Ambil detail 1 video: MP4 URL dari <source> tag.
 * @param {string} detailUrl
 * @returns {Promise<{title, thumb, videoUrl, durationText}|null>}
 */
async function scrapeDetail(detailUrl) {
  try {
    const r = await client.get(detailUrl);
    if (r.status !== 200) {
      log.warn(`[EroThots] detail HTTP ${r.status} ${detailUrl}`);
      return null;
    }
    const $ = cheerio.load(r.data);
    const body = String(r.data);

    const title = $('h1').first().text().trim() || $('title').text().replace(/\s*-\s*EroThots\s*$/, '').trim() || 'Untitled';
    const thumb = $('meta[property="og:image"]').attr('content') || null;

    // Extract MP4 from <source> tag — pattern yang paling stabil.
    // Hindari preview "thumb_vid.mp4" yang biasanya di mouseover player.
    let videoUrl = null;
    $('video source[type*="mp4"]').each((i, el) => {
      const src = $(el).attr('src');
      if (src && src.includes('.mp4') && !src.includes('thumb_vid')) {
        videoUrl = src;
        return false; // break
      }
    });

    // Fallback: cari di body (beberapa page mungkin player inline JS)
    if (!videoUrl) {
      const match = body.match(/https?:\/\/[^\s"'<>]+?(?<!thumb_vid)\.mp4[^\s"'<>]*/i);
      // Guard: skip kalau URL-nya terlihat preview
      if (match && !match[0].includes('thumb_vid')) {
        videoUrl = match[0];
      }
    }

    if (!videoUrl) {
      log.warn(`[EroThots] detail: MP4 tidak ditemukan di ${detailUrl}`);
      return { title, thumb, videoUrl: null, durationText: '' };
    }

    log.info(`[EroThots] detail: "${title.slice(0, 60)}" — ${videoUrl.slice(0, 80)}...`);
    return { title, thumb, videoUrl, durationText: '' };
  } catch (e) {
    log.error(`[EroThots] detail error: ${e.message}`);
    return null;
  }
}

/**
 * HEAD untuk estimasi ukuran. EroThots CDN (erocdn.co) support HEAD.
 */
async function probeSourceSize(url) {
  try {
    const r = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;
    const len = parseInt(r.headers['content-length'] || '0', 10);
    return len || null;
  } catch (_) {
    return null;
  }
}

/**
 * Browse video terbaru (paginasi via /videos/<page>). Untuk fitur "lihat-lihat" + gacha.
 * @param {number} page
 * @returns {Promise<{items, hasNext}>}
 */
async function scrapeBrowse(page = 1) {
  const url = page > 1 ? `${BASE_URL}/videos/${page}` : `${BASE_URL}/videos`;
  log.info(`[EroThots] browse page=${page}`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[EroThots] browse HTTP ${r.status}`); return { items: [], hasNext: false }; }
    const items = parseListingHTML(r.data);
    // /videos/<page> punya banyak halaman; anggap masih ada next selama dapat cukup item.
    const hasNext = items.length >= 20;
    log.info(`[EroThots] browse → ${items.length} items (next=${hasNext})`);
    return { items, hasNext };
  } catch (e) {
    log.error(`[EroThots] browse error: ${e.message}`);
    return { items: [], hasNext: false };
  }
}

module.exports = {
  scrapeSearch,
  scrapeBrowse,
  scrapeDetail,
  probeSourceSize,
};
