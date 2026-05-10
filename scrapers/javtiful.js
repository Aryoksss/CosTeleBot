/**
 * Javtiful scraper (pure axios — no Playwright).
 *
 * Strategi: Javtiful serve HTML klasik, search URL pattern `/search?q=X&page=N`,
 * video player URL ada di inline JSON `playerSources:[{src,type,size}]` yang di-embed
 * di HTML detail page.
 *
 * playerSources.src = AWS S3 pre-signed URL (expire 1 jam, X-Amz-Expires=3600).
 * Jadi bot harus resolve detail + start download dalam 1 jam. Tidak ada renewal mechanism.
 *
 * Output listing:
 *   { id, title, link, thumb, durationText }
 *
 * Output detail:
 *   { sources: [{ url, size: 720, type: 'video/mp4' }], title, thumb, durationText }
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://javtiful.com';
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

function resolveUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
}

/**
 * Parse satu halaman search/listing jadi array video.
 * @param {string} html
 * @returns {Array<{id,title,link,thumb,durationText}>}
 */
function parseListingHTML(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Setiap video muncul sebagai <a href="/id/video/<id>/<slug>"> ... </a>
  // yang membungkus <img> + link title + badge durasi/quality.
  $('a[href*="/video/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;
    const match = href.match(/\/video\/(\d+)\/([^/?]+)/);
    if (!match) return;

    const id = match[1];
    const img = $(el).find('img').first();
    // Thumbnail kadang lazy-loaded, coba beberapa atribut
    const thumb = img.attr('data-src') || img.attr('data-original') || img.attr('data-lazy') || img.attr('src');
    const imgAlt = img.attr('alt') || '';
    // Bersihkan "Thumbnail for " prefix di alt text
    const titleFromAlt = imgAlt.replace(/^Thumbnail for\s*/i, '').trim();

    // Badge quality/duration terletak di dalam <a> sbg span/div terpisah
    const badgeText = $(el).find('[class*="quality"], [class*="duration"], [class*="length"]').text().trim();
    const durationMatch = badgeText.match(/(\d+:\d+(?::\d+)?)/);
    const durationText = durationMatch ? durationMatch[1] : '';

    // Prioritas title: imgAlt > h2/h3 inside link > link title attr
    const title = titleFromAlt
      || $(el).find('h2, h3, .title, [class*="title"]').first().text().trim()
      || $(el).attr('title')
      || 'Untitled';

    // Filter thumb placeholder SVG
    let finalThumb = null;
    if (thumb && !thumb.includes('placeholder') && !thumb.endsWith('.svg')) {
      finalThumb = resolveUrl(thumb);
    }

    seen.add(href);
    items.push({
      id,
      title: title.slice(0, 200),
      link: resolveUrl(href),
      thumb: finalThumb,
      durationText,
    });
  });

  return items;
}

/**
 * Parse pagination info dari HTML: bookmark token ala Pinterest
 * di-simulasi sebagai { hasNext, nextPage, currentPage }.
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

/**
 * Search video di Javtiful.
 * @param {string} query
 * @param {number} page  default 1
 * @returns {Promise<{items, pagination}>}
 */
async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return { items: [], pagination: { hasNext: false } };
  const url = page > 1
    ? `${BASE_URL}/search?q=${encodeURIComponent(query)}&page=${page}`
    : `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
  log.info(`[Javtiful] search "${query}" page=${page}`);

  try {
    const r = await client.get(url);
    if (r.status !== 200) {
      log.warn(`[Javtiful] search HTTP ${r.status}`);
      return { items: [], pagination: { hasNext: false } };
    }
    const items = parseListingHTML(r.data);
    const pagination = parsePagination(r.data);
    log.info(`[Javtiful] → ${items.length} items (next=${pagination.hasNext})`);
    return { items, pagination };
  } catch (e) {
    log.error(`[Javtiful] search error: ${e.message}`);
    return { items: [], pagination: { hasNext: false } };
  }
}

/**
 * Ambil detail 1 video: sources MP4, thumbnail asli, title dari og:image + h1.
 * @param {string} detailUrl
 * @returns {Promise<{title, thumb, durationText, sources}|null>}
 */
async function scrapeDetail(detailUrl) {
  try {
    const r = await client.get(detailUrl);
    if (r.status !== 200) {
      log.warn(`[Javtiful] detail HTTP ${r.status} ${detailUrl}`);
      return null;
    }
    const $ = cheerio.load(r.data);
    const body = String(r.data);

    const title = $('h1').first().text().trim() || $('title').text().replace(/\s*\|\s*Javtiful\s*$/, '').trim() || 'Untitled';
    const thumb = $('meta[property="og:image"]').attr('content') || null;

    // Extract playerSources JSON block
    // Pattern: `"playerSources":[{"src":"...","type":"video/mp4","size":720}]`
    const playerMatch = body.match(/"playerSources"\s*:\s*(\[[^\]]+\])/);
    if (!playerMatch) {
      log.warn(`[Javtiful] detail: playerSources tidak ditemukan di ${detailUrl}`);
      return { title, thumb, durationText: '', sources: [] };
    }

    // Deserialize. JSON escape `\u0026` → `&` otomatis handle oleh JSON.parse
    let sources = [];
    try {
      sources = JSON.parse(playerMatch[1]);
    } catch (e) {
      log.warn(`[Javtiful] playerSources parse error: ${e.message}`);
      return { title, thumb, durationText: '', sources: [] };
    }

    // Normalisasi struktur source
    const normalized = sources
      .filter(s => s && s.src)
      .map(s => ({
        url: s.src,
        size: s.size || null, // resolusi (720, 1080, 480 dll)
        type: s.type || 'video/mp4',
        label: s.size ? `${s.size}p` : 'Auto',
      }))
      // Urut resolusi tertinggi ke terendah
      .sort((a, b) => (b.size || 0) - (a.size || 0));

    // Durasi dari badge jika ada
    let durationText = '';
    const durMatch = body.match(/duration["']?\s*:\s*["']?([\d:]+)/);
    if (durMatch) durationText = durMatch[1];

    log.info(`[Javtiful] detail: "${title.slice(0, 60)}" — ${normalized.length} source(s)`);
    return { title, thumb, durationText, sources: normalized };
  } catch (e) {
    log.error(`[Javtiful] detail error: ${e.message}`);
    return null;
  }
}

/**
 * HEAD-like check via Range GET untuk estimasi ukuran file sebelum full download.
 * AWS S3 pre-signed URL often rejects HEAD, jadi pakai Range request 0-0 yang return 206
 * dengan header Content-Range: bytes 0-0/<total>.
 */
async function probeSourceSize(url) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Range': 'bytes=0-0',
      },
      timeout: 15000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
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
  scrapeDetail,
  probeSourceSize,
};
