'use strict';
/**
 * Kusonime scraper — anime batch/episode download dari kusonime.com.
 * Layout: WordPress theme custom dengan <div class="smokeddlrh"> untuk download links.
 * 
 * Keunggulan: support banyak host, termasuk Google Drive direct link yang bisa di-stream tanpa bypass.
 * Domain: kusonime.com (stabil, jarang ganti)
 * 
 * Pattern URL:
 *   - Home: https://kusonime.com
 *   - Search: https://kusonime.com/?s=<query>
 *   - Detail: https://kusonime.com/<slug>/
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = () => process.env.KUSONIME_DOMAIN || 'https://kusonime.com';

const UA = require('../utils/ua').UA;

const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA } });

/**
 * Search anime by title.
 * @returns {Array<{title, slug, url, poster, genres, source}>}
 */
async function search(query) {
  const url = `${BASE()}/?s=${encodeURIComponent(query)}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const results = [];

  // Kusonime search results: <div class="venz"> with <ul> containing <li> items
  // Or <div class="rtd"> with similar structure
  // Try generic pattern: articles with h2 > a
  $('h2 > a[href*="kusonime.com"], h2.jdlz').each((_, el) => {
    let $a;
    if (el.tagName === 'a') {
      $a = $(el);
    } else {
      $a = $(el).find('a').first();
    }
    if (!$a.length) return;
    const href = $a.attr('href') || '';
    const title = $a.text().trim() || $a.attr('title') || '';
    // Filter only anime detail pages (not category/tag pages)
    if (!href || !href.includes('kusonime.com/') || href.match(/\/(genres|seasons|tag|page|credits|faq|dmca|wp-)/)) return;
    if (!title || title.length < 3) return;
    // Extract slug from URL
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    // Skip known non-content paths
    if (slug.includes('/')) return; // Only top-level slugs

    const $item = $a.closest('li, article, div');
    const poster = $item.find('img').first().attr('src') || '';
    const genres = [];
    $item.find('a[href*="/genres/"]').each((_, g) => genres.push($(g).text().trim()));

    results.push({
      title: title.replace(/\s+/g, ' ').trim(),
      slug,
      url: href,
      poster,
      genres: [...new Set(genres)],
      source: 'kusonime',
    });
  });

  // Dedupe
  const seen = new Set();
  return results.filter(r => {
    const k = r.slug.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 15);
}

/**
 * Get anime detail + download links from a Kusonime anime page.
 * @param {string} pageUrl - e.g. https://kusonime.com/steinsgate0-subtitle-indonesia/
 * @returns {{title, description, genres, qualityLinks: Array<{quality, links}>}}
 */
async function getDetail(pageUrl) {
  const { data } = await http.get(pageUrl);
  const $ = cheerio.load(data);

  const title = $('h1.jdlz').first().text().trim() || $('h1').first().text().trim();
  const description = $('.lexot p').first().text().trim() ||
    $('.info + p').first().text().trim() || '';
  const genres = [];
  $('a[href*="/genres/"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && !genres.includes(t)) genres.push(t);
  });

  // Download links: <div class="smokeurlrh"><strong>QUALITY</strong> <a>host1</a> | <a>host2</a> ...</div>
  const qualityLinks = [];
  $('div.smokeurlrh, .smokeurlrh').each((_, div) => {
    const $div = $(div);
    const quality = $div.find('strong').first().text().trim() || 'Unknown';
    const links = [];
    $div.find('a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const host = $a.text().trim();
      if (href && host && !href.startsWith('#')) {
        links.push({ host, url: href });
      }
    });
    if (links.length > 0) qualityLinks.push({ quality, links });
  });

  return { title, description, genres, qualityLinks };
}

/**
 * Classify a download host to know how to handle it.
 * @returns {string} host type: 'gdrive', 'gofile', 'terabox', 'acefile', 'krakenfiles', 'akirabox', 'hxfile', 'other'
 */
function classifyHost(url, hostLabel = '') {
  const combined = `${url} ${hostLabel}`.toLowerCase();
  if (url.includes('drive.google.com')) return 'gdrive';
  if (url.includes('gofile.io')) return 'gofile';
  if (url.includes('terabox.com') || url.includes('1024terabox.com')) return 'terabox';
  if (url.includes('acefile.co')) return 'acefile';
  if (url.includes('krakenfiles.com')) return 'krakenfiles';
  if (url.includes('akirabox.com')) return 'akirabox';
  if (url.includes('hxfile.co')) return 'hxfile';
  if (url.includes('buzzheavier.com')) return 'buzzheavier';
  if (url.includes('mega.nz') || url.includes('mega.co.nz')) return 'mega';
  return 'other';
}

/**
 * Get a random list of anime from Kusonime (for gacha feature).
 * @param {number} page - specific page or random if omitted
 * @returns {Array<{title, slug, url, poster, genres, source}>}
 */
async function scrapeListing(page = 1) {
  const url = page === 1 ? BASE() : `${BASE()}/page/${page}/`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const results = [];

  // Home page listing: similar to search, h2 > a
  $('h2 > a[href*="kusonime.com"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const title = $a.text().trim() || $a.attr('title') || '';
    if (!href || !title || href.match(/\/(genres|seasons|tag|page|credits|faq|dmca|wp-)/)) return;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (slug.includes('/')) return;

    const $item = $a.closest('li, article, div');
    const poster = $item.find('img').first().attr('src') || '';
    const genres = [];
    $item.find('a[href*="/genres/"]').each((_, g) => genres.push($(g).text().trim()));

    results.push({
      title: title.replace(/\s+/g, ' ').trim(),
      slug,
      url: href,
      poster,
      genres: [...new Set(genres)],
      source: 'kusonime',
    });
  });

  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });
}

/**
 * Random gacha: pick random page (1-497) from Kusonime listing.
 */
async function scrapeGacha() {
  const randomPage = Math.floor(Math.random() * 50) + 1; // 1-50 for recent content
  return scrapeListing(randomPage);
}

/**
 * Browse by season: /seasons/<season-slug>/
 * @param {string} seasonSlug - e.g. 'spring-2026', 'winter-2026'
 */
async function scrapeBySeason(seasonSlug, page = 1) {
  const url = `${BASE()}/seasons/${seasonSlug}/${page > 1 ? `page/${page}/` : ''}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const results = [];

  $('h2 > a[href*="kusonime.com"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const title = $a.text().trim();
    if (!href || !title || href.match(/\/(genres|seasons|tag|page)/)) return;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (slug.includes('/')) return;

    const $item = $a.closest('li, article, div');
    const poster = $item.find('img').first().attr('src') || '';
    results.push({
      title: title.replace(/\s+/g, ' ').trim(),
      slug,
      url: href,
      poster,
      genres: [],
      source: 'kusonime',
    });
  });

  const seen = new Set();
  return results.filter(r => { if (seen.has(r.slug)) return false; seen.add(r.slug); return true; });
}

/**
 * Browse by genre: /genres/<genre-slug>/
 */
async function scrapeByGenre(genreSlug, page = 1) {
  const url = `${BASE()}/genres/${genreSlug}/${page > 1 ? `page/${page}/` : ''}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const results = [];

  $('h2 > a[href*="kusonime.com"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const title = $a.text().trim();
    if (!href || !title || href.match(/\/(genres|seasons|tag|page)/)) return;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (slug.includes('/')) return;

    const $item = $a.closest('li, article, div');
    const poster = $item.find('img').first().attr('src') || '';
    results.push({
      title: title.replace(/\s+/g, ' ').trim(),
      slug,
      url: href,
      poster,
      genres: [],
      source: 'kusonime',
    });
  });

  const seen = new Set();
  return results.filter(r => { if (seen.has(r.slug)) return false; seen.add(r.slug); return true; });
}

module.exports = { search, getDetail, classifyHost, scrapeListing, scrapeGacha, scrapeBySeason, scrapeByGenre };
