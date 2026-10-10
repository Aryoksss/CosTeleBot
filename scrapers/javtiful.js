/**
 * Javtiful scraper (pure axios — no Playwright).
 *
 * Sumber data utama:
 *   1. HTML listing search/category/actress
 *   2. JSON-LD `VideoObject` script di detail page (paling kaya metadata)
 *   3. Inline `playerSources` JSON di detail page (untuk URL MP4)
 *
 * playerSources.src = AWS S3 pre-signed URL (expire 1 jam, X-Amz-Expires=3600).
 * Bot harus resolve detail + start download dalam 1 jam.
 *
 * Public API:
 *   scrapeSearch(query, page)
 *   scrapeActress(slug, page)
 *   scrapeCategory(slug, page)
 *   scrapeDetail(detailUrl)
 *   probeSourceSize(url)
 *   detectJavCode(title)  // helper public
 *   parseIsoDuration(iso) // helper public
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://javtiful.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── RETRY CONFIG ────────────────────────────────────────────────────────────
const RETRY_MAX = 3;
const RETRY_BASE_MS = 2000;       // mulai 2 detik
const RETRY_MAX_MS = 15000;       // cap 15 detik
const REQUEST_JITTER_MS = 500;    // random jitter 0-500ms tiap request

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Jittered sleep untuk anti-rate-limit + backoff. */
function sleep(ms) {
  const jitter = Math.random() * REQUEST_JITTER_MS;
  return new Promise(r => setTimeout(r, ms + jitter));
}

/** Cek apakah error adalah TLS/socket disconnect (transient). */
function isTransientError(err) {
  const msg = (err.message || '').toLowerCase();
  return /socket disconnect|tls|econnreset|econnrefused|etimedout|enotfound|429|503|502|cloudflare/i.test(msg);
}

/**
 * Wrapper retry untuk HTTP GET dengan exponential backoff.
 * Hanya retry pada error transient (TLS drop, ECONNRESET, timeout, 429, 5xx).
 */
async function getWithRetry(url, maxRetries = RETRY_MAX) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Jitter kecil tiap request untuk hindari detection pattern.
      if (attempt > 0) {
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
        log.warn(`[Javtiful] retry ${attempt}/${maxRetries} dalam ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
      } else {
        await sleep(0); // jitter saja
      }
      return await client.get(url);
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e)) break; // non-transient: jangan retry
    }
  }
  throw lastErr;
}

function resolveUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
}

// Judul dari situs memakai format berhubung "MIDE-232" atau dibungkus [MIDE-232].
// Wajib ada dash / bracket supaya judul bebas seperti "girl 123" tidak ikut dikenali.
const JAV_CODE_TITLE_RE = /(?:^|\s|[([【])\s*([A-Za-z][A-Za-z0-9]{1,7})-(\d{2,5})\s*(?=$|\s|[)\]】])/;

/**
 * Return { full, prefix, number } kalau title mengandung kode JAV berhubung, else null.
 * Dipakai untuk judul hasil scraping (bukan input mentah user).
 */
function detectJavCode(title) {
  if (!title) return null;
  const m = String(title).match(JAV_CODE_TITLE_RE);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  return { full: `${prefix}-${m[2]}`, prefix, number: m[2] };
}

// Input user boleh tanpa dash ("mide232"). Tanpa pemisah prefix wajib huruf murni
// (MIDE232 → MIDE-232); dengan pemisah prefix boleh alfanumerik (T28-123).
const JAV_INPUT_RE = /^([A-Za-z][A-Za-z0-9]{1,7})[\s-]+(\d{2,5})$|^([A-Za-z]{2,8})(\d{2,5})$/;

/**
 * "mide232" / "MIDE 232" → "MIDE-232"; input non-kode dikembalikan apa adanya (trimmed).
 */
function normalizeJavCode(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const m = raw.match(JAV_INPUT_RE);
  if (m) {
    const prefix = (m[1] || m[3]).toUpperCase();
    return `${prefix}-${m[2] || m[4]}`;
  }
  return raw;
}

/**
 * Parse ISO 8601 duration string (PT2H5M17S) ke "HH:MM:SS" atau "MM:SS".
 */
function parseIsoDuration(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return '';
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${pad(h)}:${pad(min)}:${pad(s)}`;
  return `${pad(min)}:${pad(s)}`;
}

/**
 * Extract thumbnail URL dari <img> dengan support atribut lazy-load Javtiful.
 * Fallback chain diurutkan berdasarkan prioritas resolusi (sm > original).
 */
function extractThumb($img) {
  // Javtiful pakai data-front-lazy-src (resolusi small) dan data-front-lazy-fallback-src
  // (format: "original|xs" pipe-separated).
  const lazySrc = $img.attr('data-front-lazy-src');
  const fallback = $img.attr('data-front-lazy-fallback-src') || '';
  const fallbackOriginal = fallback.split('|')[0];
  const src = $img.attr('src');
  const candidate = lazySrc || fallbackOriginal || $img.attr('data-src') || $img.attr('data-original') || src;
  if (!candidate) return null;
  if (candidate.includes('placeholder') || candidate.endsWith('.svg')) return null;
  return resolveUrl(candidate);
}

// ─── LISTING PARSER ──────────────────────────────────────────────────────────

/**
 * Parse satu halaman listing (search/actress/category/trending).
 * @returns {Array<{id,title,link,thumb,durationText,javCode}>}
 */
function parseListingHTML(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('a[href*="/video/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;
    const match = href.match(/\/video\/(\d+)\/([^/?]+)/);
    if (!match) return;

    const id = match[1];
    const img = $(el).find('img').first();
    const imgAlt = img.attr('alt') || '';
    const titleFromAlt = imgAlt.replace(/^Thumbnail for\s*/i, '').trim();

    // Badge quality/duration di dalam <a>
    const badgeText = $(el).find('[class*="quality"], [class*="duration"], [class*="length"]').text().trim();
    const durationMatch = badgeText.match(/(\d+:\d+(?::\d+)?)/);
    const durationText = durationMatch ? durationMatch[1] : '';

    const title = titleFromAlt
      || $(el).find('h2, h3, .title, [class*="title"]').first().text().trim()
      || $(el).attr('title')
      || 'Untitled';

    const thumb = extractThumb(img);
    const javCode = detectJavCode(title);

    seen.add(href);
    items.push({
      id,
      title: title.slice(0, 200),
      link: resolveUrl(href),
      thumb,
      durationText,
      javCode: javCode ? javCode.full : null,
    });
  });

  return items;
}

/**
 * Parse pagination info dari HTML listing.
 */
function parsePagination(html) {
  const $ = cheerio.load(html);
  let currentPage = 1;
  let nextPage = null;
  $('.front-pagination-link, a[href*="page="]').each((i, el) => {
    const txt = $(el).text().trim();
    const href = $(el).attr('href') || '';
    const pageMatch = href.match(/[?&]page=(\d+)/);
    if ($(el).hasClass('is-active') || $(el).attr('aria-current') === 'page') {
      const m = txt.match(/^\d+$/);
      if (m) currentPage = parseInt(txt, 10);
    }
    if (txt.toLowerCase().includes('berikut') || txt.toLowerCase().includes('next') || /^»$/.test(txt)) {
      if (pageMatch) nextPage = parseInt(pageMatch[1], 10);
    }
  });
  return { currentPage, nextPage, hasNext: nextPage !== null };
}

// ─── SEARCH / ACTRESS / CATEGORY ─────────────────────────────────────────────

async function scrapeListingByUrl(url, label) {
  try {
    const r = await getWithRetry(url);
    if (r.status !== 200) {
      log.warn(`[Javtiful] ${label} HTTP ${r.status}`);
      return { items: [], pagination: { hasNext: false } };
    }
    const items = parseListingHTML(r.data);
    const pagination = parsePagination(r.data);
    log.info(`[Javtiful] ${label} → ${items.length} items (next=${pagination.hasNext})`);
    return { items, pagination };
  } catch (e) {
    log.error(`[Javtiful] ${label} error: ${e.message}`);
    return { items: [], pagination: { hasNext: false } };
  }
}

async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return { items: [], pagination: { hasNext: false } };
  const url = page > 1
    ? `${BASE_URL}/search?q=${encodeURIComponent(query)}&page=${page}`
    : `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
  return scrapeListingByUrl(url, `search "${query}" page=${page}`);
}

/**
 * Browse semua video dari satu aktris.
 * URL pattern: /actress/<slug>?page=N
 */
async function scrapeActress(slug, page = 1) {
  if (!slug) return { items: [], pagination: { hasNext: false } };
  const url = page > 1
    ? `${BASE_URL}/actress/${slug}?page=${page}`
    : `${BASE_URL}/actress/${slug}`;
  return scrapeListingByUrl(url, `actress "${slug}" page=${page}`);
}

/**
 * Browse semua video dari satu kategori.
 * URL pattern: /category/<slug>?page=N
 */
async function scrapeCategory(slug, page = 1) {
  if (!slug) return { items: [], pagination: { hasNext: false } };
  const url = page > 1
    ? `${BASE_URL}/category/${slug}?page=${page}`
    : `${BASE_URL}/category/${slug}`;
  return scrapeListingByUrl(url, `category "${slug}" page=${page}`);
}

/**
 * Trending page - 23 video trending daily.
 */
async function scrapeTrending() {
  return scrapeListingByUrl(`${BASE_URL}/trending`, 'trending');
}

/**
 * Latest video catalog - paginated up to ~2000 pages (~46k video).
 * Dipakai untuk gacha random dari seluruh database.
 */
async function scrapeLatest(page = 1) {
  const url = page > 1 ? `${BASE_URL}/videos?page=${page}` : `${BASE_URL}/videos`;
  return scrapeListingByUrl(url, `latest page=${page}`);
}

// ─── DETAIL PAGE ─────────────────────────────────────────────────────────────

function parseJsonLd(html) {
  const $ = cheerio.load(html);
  let videoLd = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const raw = $(el).html();
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of arr) {
        if (obj && obj['@type'] === 'VideoObject') {
          videoLd = obj;
          break;
        }
      }
    } catch (_) { }
  });
  return videoLd;
}

function extractActressesAndCategories($) {
  const actresses = [];
  const actressSeen = new Set();
  // Matches /actress/<slug> — capture trailing part (skip leading locale prefix like /id/)
  $('a[href*="/actress/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/actress\/([^/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (actressSeen.has(slug)) return;
    const name = $(el).text().trim();
    if (!name || name.length < 2) return;
    actressSeen.add(slug);
    actresses.push({ slug, name: name.slice(0, 100) });
  });

  const categories = [];
  const catSeen = new Set();
  $('a[href*="/category/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    // Exclude /categories navigation link (plural)
    if (/\/categories(\/|$|\?)/.test(href)) return;
    const m = href.match(/\/category\/([^/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (catSeen.has(slug)) return;
    const name = $(el).text().trim();
    if (!name || name.length < 2) return;
    catSeen.add(slug);
    categories.push({ slug, name: name.slice(0, 80) });
  });

  return { actresses, categories };
}

function extractRelatedVideos($, currentVideoId) {
  const related = [];
  const seen = new Set();
  $('a[href*="/video/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;
    const m = href.match(/\/video\/(\d+)\/([^/?]+)/);
    if (!m) return;
    if (m[1] === currentVideoId) return; // skip diri sendiri

    const id = m[1];
    const img = $(el).find('img').first();
    const imgAlt = img.attr('alt') || '';
    const title = imgAlt.replace(/^Thumbnail for\s*/i, '').trim() || 'Untitled';
    const thumb = extractThumb(img);
    const badge = $(el).find('[class*="quality"], [class*="duration"], [class*="length"]').text().trim();
    const durationMatch = badge.match(/(\d+:\d+(?::\d+)?)/);

    seen.add(href);
    related.push({
      id,
      title: title.slice(0, 200),
      link: resolveUrl(href),
      thumb,
      durationText: durationMatch ? durationMatch[1] : '',
    });
  });
  return related;
}

/**
 * Ambil detail 1 video: metadata lengkap + sources MP4.
 * @returns {Promise<{
 *   title, description, thumb, durationText, uploadDate, viewCount,
 *   sources: [{url, size, type, label}],
 *   actresses: [{slug, name}],
 *   categories: [{slug, name}],
 *   related: [{id, title, link, thumb, durationText}],
 *   javCode: {full, prefix, number}|null
 * }|null>}
 */
async function scrapeDetail(detailUrl) {
  try {
    const r = await getWithRetry(detailUrl);
    if (r.status !== 200) {
      log.warn(`[Javtiful] detail HTTP ${r.status} ${detailUrl}`);
      return null;
    }
    const $ = cheerio.load(r.data);
    const body = String(r.data);

    // Current video ID untuk filter related
    const idMatch = detailUrl.match(/\/video\/(\d+)\//);
    const currentVideoId = idMatch ? idMatch[1] : null;

    // Prefer JSON-LD untuk title/thumb/duration/date/views (paling presisi)
    const jsonLd = parseJsonLd(body);
    const fallbackTitle = $('h1').first().text().trim()
      || $('title').text().replace(/\s*\|\s*Javtiful\s*$/, '').trim()
      || 'Untitled';

    const title = (jsonLd?.name || fallbackTitle).trim();
    const description = (jsonLd?.description || $('meta[property="og:description"]').attr('content') || '').trim();
    const thumb = jsonLd?.thumbnailUrl
      || (Array.isArray(jsonLd?.thumbnailUrl) ? jsonLd.thumbnailUrl[0] : null)
      || $('meta[property="og:image"]').attr('content')
      || null;
    const durationText = parseIsoDuration(jsonLd?.duration);
    const uploadDate = jsonLd?.uploadDate
      || $('meta[property="article:published_time"]').attr('content')
      || null;

    // View count dari JSON-LD interactionStatistic
    let viewCount = null;
    const stat = jsonLd?.interactionStatistic;
    if (stat) {
      const arr = Array.isArray(stat) ? stat : [stat];
      for (const s of arr) {
        if (s && s.userInteractionCount != null) {
          viewCount = parseInt(s.userInteractionCount, 10);
          break;
        }
      }
    }

    // Extract playerSources JSON block (untuk URL MP4)
    const playerMatch = body.match(/"playerSources"\s*:\s*(\[[^\]]+\])/);
    let sources = [];
    if (playerMatch) {
      try {
        const parsed = JSON.parse(playerMatch[1]);
        sources = parsed
          .filter(s => s && s.src)
          .map(s => ({
            url: resolveUrl(s.src),
            size: s.size || null,
            type: s.type || 'video/mp4',
            label: s.size ? `${s.size}p` : 'Auto',
          }))
          .sort((a, b) => (b.size || 0) - (a.size || 0));
      } catch (e) {
        log.warn(`[Javtiful] playerSources parse error: ${e.message}`);
      }
    } else {
      log.warn(`[Javtiful] playerSources tidak ditemukan di ${detailUrl}`);
    }

    const { actresses, categories } = extractActressesAndCategories($);
    const related = extractRelatedVideos($, currentVideoId);
    const javCode = detectJavCode(title);

    log.info(`[Javtiful] detail: "${title.slice(0, 50)}" — ${sources.length} src, ${actresses.length} actr, ${categories.length} cat, ${related.length} rel`);
    return {
      title,
      description,
      thumb,
      durationText,
      uploadDate,
      viewCount,
      sources,
      actresses,
      categories,
      related,
      javCode,
    };
  } catch (e) {
    log.error(`[Javtiful] detail error: ${e.message}`);
    return null;
  }
}

// ─── PROBE SIZE ──────────────────────────────────────────────────────────────

async function probeSourceSize(url) {
  try {
    const r = await client.get(url, {
      headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' },
      timeout: 15000,
      responseType: 'arraybuffer',
    });
    if (r.status !== 206 && r.status !== 200) return null;
    const range = r.headers['content-range'] || '';
    const match = range.match(/\/(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  scrapeSearch,
  scrapeActress,
  scrapeCategory,
  scrapeTrending,
  scrapeLatest,
  scrapeDetail,
  probeSourceSize,
  detectJavCode,
  normalizeJavCode,
  parseIsoDuration,
};
