/**
 * Cosplaytele scraper.
 *
 * Listing URL patterns:
 *   search     → /?s=<query> or /page/<N>/?s=<query>
 *   category   → /category/<slug>/page/<N>/
 *   tag        → /tag/<slug>/page/<N>/
 *   cosplayer  → /category/<cosplayer-slug>/page/<N>/   (cosplayer slug = category itself)
 *   trending   → /24-hours/, /3-day/, /7-day/, /best-cosplayer/
 *
 * Post card struktur:
 *   <a href="/<slug>/" class="plain" aria-label="<cosplayer> cosplay <character> – <series> N photos [and M videos]">
 *     <img src|data-src="...">
 *   </a>
 *
 * Title/metadata di-extract dari aria-label (bukan innerHTML yang kosong).
 *
 * Public API:
 *   scrapeListing(page, category, query)     (backward compat)
 *   scrapeSearch(query, page)
 *   scrapeCategory(slug, page)
 *   scrapeTag(slug, page)
 *   scrapeTrending(window='24-hours')        window: '24-hours' | '3-day' | '7-day' | 'best-cosplayer'
 *   scrapePostDetail(postUrl)
 *   CATEGORIES  (legacy map)
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://cosplaytele.com';

const CATEGORIES = {
  home: '/',
  cosplay_ero: '/category/cosplay-ero/',
  nude: '/category/nude/',
  video: '/category/video-cosplayy/',
  best: '/best-cosplayer/',
};

const TRENDING_WINDOWS = {
  '24-hours': '/24-hours/',
  '3-day': '/3-day/',
  '7-day': '/7-day/',
  'best-cosplayer': '/best-cosplayer/',
};

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const httpClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  validateStatus: () => true,
});

// URL path yang BUKAN post (filter false positive dari scraping)
const NON_POST_SLUGS = new Set([
  'explore-categories', '24-hours', '3-day', '7-day',
  'best-cosplayer', 'dmca', 'contact', 'about', 'privacy',
  'terms', 'sitemap', 'login', 'register', 'category', 'tag', 'page',
  'search', 'shop', 'cart', 'checkout', 'wishlist', 'my-account', 'account',
]);

function isPostUrl(url) {
  if (!url) return false;
  if (!url.startsWith(`${BASE_URL}/`)) return false;
  if (url.match(/\/(category|tag|page|author)\//)) return false;
  // Must match /<slug>/ or /<slug>
  const m = url.match(/^https:\/\/cosplaytele\.com\/([a-z0-9][a-z0-9-]*)\/?$/i);
  if (!m) return false;
  if (NON_POST_SLUGS.has(m[1].toLowerCase())) return false;
  return true;
}

/**
 * Parse aria-label untuk ekstrak metadata:
 *   "Tiny Asa (tiny.asababy) cosplay Castorice – Honkai:Star Rail "82 photos and 2 videos""
 * Return: { title, cosplayer, character, series, photoCount, videoCount }
 */
function parseAriaLabel(label) {
  if (!label) return { title: '' };

  // Normalize curly quotes dan dashes
  const norm = label
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .trim();

  // Photo + video count
  let photoCount = null, videoCount = null;
  const countMatch = norm.match(/"?(\d+)\s+photo(?:s)?(?:\s+and\s+(\d+)\s+video)?/i);
  if (countMatch) {
    photoCount = parseInt(countMatch[1], 10);
    if (countMatch[2]) videoCount = parseInt(countMatch[2], 10);
  }

  // "<cosplayer> cosplay <character> - <series>"
  // Pisah dulu bagian count-nya
  const beforeCount = norm.replace(/"?\d+\s+photo.*$/i, '').trim();

  let cosplayer = null, character = null, series = null;

  // Pattern A: "... cosplay <character> - <series>"
  const mCosplay = beforeCount.match(/^(.+?)\s+cosplay\s+(.+?)(?:\s+-\s+(.+))?$/i);
  if (mCosplay) {
    cosplayer = mCosplay[1].trim();
    character = mCosplay[2].trim();
    series = mCosplay[3] ? mCosplay[3].trim() : null;
  } else {
    // Pattern B (no "cosplay" kata): "<cosplayer> - <character> [series]"
    const mDash = beforeCount.match(/^(.+?)\s+-\s+(.+)$/);
    if (mDash) {
      cosplayer = mDash[1].trim();
      // Jika ada substring dalam bracket [...] atau (...) di character, extract sebagai series
      const charMatch = mDash[2].match(/^(.+?)\s*[\[\(]([^\]\)]+)[\]\)]\s*$/);
      if (charMatch) {
        character = charMatch[1].trim();
        series = charMatch[2].trim();
      } else {
        character = mDash[2].trim();
      }
    }
  }

  // Fallback: title yang manusiawi
  const title = beforeCount || norm.slice(0, 200);

  return {
    title: title.slice(0, 200),
    cosplayer,
    character,
    series,
    photoCount,
    videoCount,
  };
}

/**
 * Extract best thumbnail dari <img>: handle lazy-load WordPress theme.
 */
function extractThumb($img) {
  // Prioritas: data-src > srcset(largest) > src, filter placeholder
  const dataSrc = $img.attr('data-src');
  const srcset = $img.attr('srcset');
  const src = $img.attr('src');

  // srcset format: "url1 100w, url2 200w, ..." — ambil largest yang bukan placeholder
  if (srcset) {
    const entries = srcset.split(',').map(s => s.trim()).filter(s => s);
    const parsed = entries.map(e => {
      const parts = e.split(/\s+/);
      const url = parts[0];
      const w = parts[1] ? parseInt(parts[1], 10) : 0;
      return { url, w };
    }).filter(e => e.url && !e.url.includes('placeholder'));
    parsed.sort((a, b) => b.w - a.w);
    if (parsed.length > 0) return parsed[0].url;
  }

  for (const candidate of [dataSrc, src]) {
    if (!candidate) continue;
    if (candidate.includes('placeholder') || candidate.endsWith('.svg')) continue;
    if (candidate.startsWith('data:')) continue;
    return candidate;
  }
  return null;
}

/**
 * Parse listing HTML → array post.
 */
function parseListingHTML(html) {
  const $ = cheerio.load(html);
  const postsMap = new Map();

  // Pattern utama: <a href="/<slug>/" aria-label="..."><img></a>
  // Tapi Cosplaytele kadang punya dual structure (image card + title card).
  // Strategi: iterate semua <a href> valid post, merge by href.
  $('a[href^="https://cosplaytele.com/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (!isPostUrl(href)) return;

    const ariaLabel = $a.attr('aria-label') || '';
    const titleAttr = $a.attr('title') || '';
    const textContent = $a.text().trim();
    const $img = $a.find('img').first();

    const rawTitle = ariaLabel || titleAttr || textContent;
    const meta = parseAriaLabel(rawTitle);
    const thumb = $img.length ? extractThumb($img) : null;

    // Merge ke existing entry (karena satu post bisa punya 2 anchor: image + title)
    const existing = postsMap.get(href) || { url: href, title: '', thumb: null };

    // Pilih title yang paling informatif (aria-label > text fallback)
    if (meta.title && (!existing.title || meta.title.length > existing.title.length)) {
      existing.title = meta.title;
      existing.cosplayer = meta.cosplayer || existing.cosplayer;
      existing.character = meta.character || existing.character;
      existing.series = meta.series || existing.series;
      existing.photoCount = meta.photoCount ?? existing.photoCount;
      existing.videoCount = meta.videoCount ?? existing.videoCount;
    }
    // Thumbnail: prefer yang non-null (dari image card)
    if (thumb && !existing.thumb) existing.thumb = thumb;

    postsMap.set(href, existing);
  });

  // Filter: harus ada title minimal
  return Array.from(postsMap.values()).filter(p => p.title && p.title.length > 3);
}

async function scrapeListingByUrl(url, label) {
  try {
    const r = await httpClient.get(url);
    if (r.status !== 200) {
      log.warn(`[Cosplaytele] ${label} HTTP ${r.status}`);
      return [];
    }
    const items = parseListingHTML(r.data);
    log.info(`[Cosplaytele] ${label} → ${items.length} posts`);
    return items;
  } catch (err) {
    log.error(`[Cosplaytele] ${label} error: ${err.message}`);
    return [];
  }
}

/**
 * Search post.
 */
async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return [];
  const url = page > 1
    ? `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`
    : `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  return scrapeListingByUrl(url, `search "${query}" page=${page}`);
}

/**
 * Browse category (bisa juga cosplayer slug karena pakai /category/<slug>/).
 */
async function scrapeCategory(slug, page = 1) {
  if (!slug) return [];
  const cleanSlug = String(slug).replace(/^\/+|\/+$/g, '');
  const url = page > 1
    ? `${BASE_URL}/category/${cleanSlug}/page/${page}/`
    : `${BASE_URL}/category/${cleanSlug}/`;
  return scrapeListingByUrl(url, `category "${cleanSlug}" page=${page}`);
}

/**
 * Browse tag (character / series).
 */
async function scrapeTag(slug, page = 1) {
  if (!slug) return [];
  const cleanSlug = String(slug).replace(/^\/+|\/+$/g, '');
  const url = page > 1
    ? `${BASE_URL}/tag/${cleanSlug}/page/${page}/`
    : `${BASE_URL}/tag/${cleanSlug}/`;
  return scrapeListingByUrl(url, `tag "${cleanSlug}" page=${page}`);
}

/**
 * Trending post by window.
 */
async function scrapeTrending(windowKey = '24-hours') {
  const path = TRENDING_WINDOWS[windowKey] || TRENDING_WINDOWS['24-hours'];
  return scrapeListingByUrl(`${BASE_URL}${path}`, `trending ${windowKey}`);
}

/**
 * Legacy wrapper untuk backward compat dengan telegram-bot.js existing.
 */
async function scrapeListing(page = 1, category = 'home', query = null) {
  if (query) return scrapeSearch(query, page);
  const catPath = CATEGORIES[category] || '/';
  if (catPath === '/') {
    // Home: paginate dengan /page/<N>/
    const url = page > 1 ? `${BASE_URL}/page/${page}/` : BASE_URL + '/';
    return scrapeListingByUrl(url, `home page=${page}`);
  }
  // Category paths: add /page/N/
  const url = page > 1
    ? `${BASE_URL}${catPath}page/${page}/`
    : `${BASE_URL}${catPath}`;
  return scrapeListingByUrl(url, `${category} page=${page}`);
}

// ─── DETAIL PAGE ─────────────────────────────────────────────────────────────

/**
 * Parse detail page: download links, password, metadata, preview gallery, tags.
 * Return extended object (backward-compatible with existing fields).
 */
async function scrapePostDetail(postUrl) {
  try {
    const r = await httpClient.get(postUrl);
    if (r.status !== 200) {
      log.warn(`[Cosplaytele] detail HTTP ${r.status} ${postUrl}`);
      return null;
    }
    const $ = cheerio.load(r.data);

    const links = {
      gofile: null,
      sorafolder: null,
      telegram: null,
      terabox: null,
      mediafire: null,
      password: null,

      // Extended fields (baru):
      title: null,
      meta: null,                // { cosplayer, character, series, photoCount, videoCount }
      thumb: null,
      previewImages: [],          // up to 10 sample image URLs
      cosplayerSlug: null,        // dari /category/<slug>/ (cosplayer)
      characterTag: null,         // { slug, name } dari /tag/<slug>/
      seriesTag: null,            // { slug, name } dari /tag/<slug>/ (jika ada lebih dari 1 tag, ambil yang match heuristic series)
      allTags: [],                // full tag list [{slug, name}]
      allCategories: [],          // full category list [{slug, name}]
    };

    // === 1. Download links (legacy logic, keep) ===
    $('a[href]').each((_, el) => {
      const h = $(el).attr('href');
      if (!h) return;
      if (!links.gofile && h.includes('gofile.io')) links.gofile = h;
      else if (!links.sorafolder && h.includes('sorafolder.com')) links.sorafolder = h;
      else if (!links.telegram && h.includes('t.me')) links.telegram = h;
      else if (!links.terabox && (h.includes('terabox.com') || h.includes('1024terabox.com'))) links.terabox = h;
      else if (!links.mediafire && h.includes('mediafire.com')) links.mediafire = h;
    });

    // === 2. Password ===
    // Semua arsip dari Cosplaytele (Gofile/SoraFolder/MediaFire) konsisten memakai password
    // "cosplaytele". Hardcode di sini supaya bot selalu dapat password pasti, bypass regex
    // heuristic yang rawan false positive dari teks marketing di body ("Enjoy better photo...").
    //
    // Fallback ke env ARCHIVE_PASSWORDS juga aktif di extractArchive() sebagai safety net.
    links.password = 'cosplaytele';

    // === 3. Title + parsed metadata dari <h1> ===
    const h1Text = $('h1').first().text().trim();
    if (h1Text) {
      links.title = h1Text.slice(0, 250);
      const parsed = parseAriaLabel(h1Text);
      links.meta = {
        cosplayer: parsed.cosplayer,
        character: parsed.character,
        series: parsed.series,
        photoCount: parsed.photoCount,
        videoCount: parsed.videoCount,
      };
    }

    // === 4. Preview gallery (ambil 10 image pertama dari entry-content) ===
    const previewSet = new Set();
    $('.entry-content img, article .entry-content img').each((_, el) => {
      if (previewSet.size >= 10) return;
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.includes('wp-content/uploads') && !src.endsWith('.svg')) {
        previewSet.add(src);
      }
    });
    links.previewImages = [...previewSet];
    // Thumbnail primary: image pertama dari gallery
    if (previewSet.size > 0) links.thumb = [...previewSet][0];

    // === 5. Categories + tags ===
    const catMap = new Map();
    $('a[rel*="category"], a[href*="/category/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/category\/([^/?#]+)\/?/);
      if (!m) return;
      const slug = m[1];
      if (['video-cosplayy', 'game', 'nude', 'cosplay-ero', 'cosplay', 'category'].includes(slug)) {
        // Standard category, tambahkan ke allCategories biasa
      }
      if (!catMap.has(slug)) {
        const name = $(el).text().trim();
        if (name && name.length >= 2) catMap.set(slug, { slug, name: name.slice(0, 80) });
      }
    });
    links.allCategories = [...catMap.values()];

    // Deteksi cosplayer slug: cosplaytele pakai /category/<cosplayer>/ untuk halaman cosplayer,
    // TAPI genre juga kategori (Cosplay Nude, Cosplay Free Style, dll) → gampang false positive.
    // Strategi: cocokkan nama kategori dengan nama cosplayer dari judul. Genre selalu diawali
    // "Cosplay ..." sehingga gampang difilter.
    const STANDARD_CATS = new Set([
      'video-cosplayy', 'game', 'nude', 'cosplay-ero', 'cosplay', 'best-cosplayer',
      'free-style', 'cosplay-nude', 'cosplay-free-style', 'uncensored', 'uncategorized',
    ]);
    const normName = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const cosName = normName(links.meta && links.meta.cosplayer);

    let cosplayerCat = null;
    // 1) Match by name (paling akurat)
    if (cosName) {
      cosplayerCat = links.allCategories.find(c => {
        if (STANDARD_CATS.has(c.slug)) return false;
        const cn = normName(c.name);
        return cn && (cn === cosName || cosName.includes(cn) || cn.includes(cosName));
      });
    }
    // 2) Fallback: kategori non-standar yang namanya BUKAN genre (genre selalu diawali "Cosplay ")
    if (!cosplayerCat) {
      cosplayerCat = links.allCategories.find(c => !STANDARD_CATS.has(c.slug) && !/^cosplay\b/i.test(c.name));
    }
    // Kalau tetap tak ketemu → null (bot akan fallback ke pencarian nama cosplayer)
    links.cosplayerSlug = cosplayerCat ? cosplayerCat.slug : null;

    const tagMap = new Map();
    $('a[rel*="tag"], a[href*="/tag/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/tag\/([^/?#]+)\/?/);
      if (!m) return;
      const slug = m[1];
      if (!tagMap.has(slug)) {
        const name = $(el).text().trim();
        if (name && name.length >= 2) tagMap.set(slug, { slug, name: name.slice(0, 80) });
      }
    });
    links.allTags = [...tagMap.values()];

    // Heuristic: tag pertama biasanya character, kedua series.
    // Tapi cosplaytele kadang cuma 1 tag. Fallback: pakai urutan.
    if (links.allTags.length >= 1) links.characterTag = links.allTags[0];
    if (links.allTags.length >= 2) links.seriesTag = links.allTags[1];

    return links;
  } catch (err) {
    log.error(`[Cosplaytele] detail error: ${err.message}`);
    return null;
  }
}

module.exports = {
  // Legacy API
  scrapeListing,
  scrapePostDetail,
  CATEGORIES,
  // New API
  scrapeSearch,
  scrapeCategory,
  scrapeTag,
  scrapeTrending,
  TRENDING_WINDOWS,
  // Helpers (exposed untuk testing)
  parseAriaLabel,
  isPostUrl,
};
