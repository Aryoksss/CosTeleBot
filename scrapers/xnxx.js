'use strict';

/**
 * XNXX scraper (pure axios — no Playwright).
 *
 * Search   : /search/<query>/<page0>        (page 0-indexed → bot page 1 = /0)
 * Browse   : /todays-selection/<page>        (page 1-indexed)
 * Listing  : div.thumb-block > a[href^="/video-..."] + img[data-src] + .metadata
 * Detail JS: html5player.setVideoUrlHigh('...mp4'), setVideoUrlLow('...mp4'),
 *            setVideoHLS('...m3u8'), setVideoTitle('...'), setThumbUrl('...')
 *
 * Kualitas: setVideoUrlHigh hanya 360p; resolusi penuh (720p/1080p/1440p) ada di HLS.
 * Maka detail mengembalikan hlsUrl (untuk ffmpeg, kualitas terbaik) + videoUrl (mp4 360p fallback).
 *
 * Output:
 *   listing: [{ id, title, link, thumb, durationText, quality }]
 *   detail:  { title, thumb, videoUrl, hlsUrl, durationText }
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.xnxx.com';
const UA = require('../utils/ua').UA;

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
  },
  timeout: 20000,
  maxRedirects: 5,
  validateStatus: () => true,
});

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#0?39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");
}

function extractVideoId(href) {
  const m = String(href || '').match(/\/video-([^/]+)\//);
  return m ? m[1] : null;
}

function parseMeta(metaText) {
  const t = String(metaText || '').replace(/\s+/g, ' ').trim();
  const durM = t.match(/(\d+)\s*min/i) || t.match(/(\d+)\s*sec/i);
  const qM = t.match(/(\d{3,4}p)/i);
  return {
    durationText: durM ? durM[0].replace(/\s+/g, '') : '',
    quality: qM ? qM[1] : '',
  };
}

function parseListingHTML(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.thumb-block').each((i, el) => {
    const $el = $(el);
    const a = $el.find('a[href^="/video-"]').first();
    const href = a.attr('href');
    if (!href) return;
    const id = extractVideoId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const under = $el.find('.thumb-under');
    const titleA = under.find('a[href^="/video-"]').first();
    const title = decodeEntities(titleA.attr('title') || titleA.text().trim() || a.attr('title') || '').trim();

    const img = $el.find('img').first();
    const thumb = img.attr('data-src') || img.attr('src');
    const { durationText, quality } = parseMeta(under.find('.metadata').text());

    items.push({
      id,
      title: (title || 'Untitled').slice(0, 200),
      link: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      thumb: thumb && thumb.startsWith('http') && !thumb.includes('lightbox-blank') ? thumb : null,
      durationText,
      quality,
    });
  });

  return items;
}

/**
 * Search video. Bot page 1 → xnxx /0 (0-indexed).
 * @returns {Promise<{items, hasNext}>}
 */
async function scrapeSearch(query, page = 1) {
  if (!query || !query.trim()) return { items: [], hasNext: false };
  const xpage = Math.max(0, (parseInt(page, 10) || 1) - 1);
  const url = `${BASE_URL}/search/${encodeURIComponent(query)}/${xpage}`;
  log.info(`[XNXX] search "${query}" page=${page} (x=${xpage})`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[XNXX] search HTTP ${r.status}`); return { items: [], hasNext: false }; }
    const items = parseListingHTML(r.data);
    const hasNext = items.length >= 20;
    log.info(`[XNXX] search → ${items.length} items (next=${hasNext})`);
    return { items, hasNext };
  } catch (e) {
    log.error(`[XNXX] search error: ${e.message}`);
    return { items: [], hasNext: false };
  }
}

/**
 * Browse video pilihan terbaru. /todays-selection/<page> (1-indexed, ~4-5 halaman saja).
 * @returns {Promise<{items, hasNext}>}
 */
async function scrapeBrowse(page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const url = `${BASE_URL}/todays-selection/${p}`;
  log.info(`[XNXX] browse page=${p}`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[XNXX] browse HTTP ${r.status}`); return { items: [], hasNext: false }; }
    const items = parseListingHTML(r.data);
    const hasNext = items.length >= 20;
    log.info(`[XNXX] browse → ${items.length} items (next=${hasNext})`);
    return { items, hasNext };
  } catch (e) {
    log.error(`[XNXX] browse error: ${e.message}`);
    return { items: [], hasNext: false };
  }
}

/**
 * Top video (paginate dalam, cocok untuk gacha). /best/month/<page> (1-indexed).
 * @returns {Promise<{items, hasNext}>}
 */
async function scrapeBest(page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const url = `${BASE_URL}/best/month/${p}`;
  log.info(`[XNXX] best page=${p}`);
  try {
    const r = await client.get(url);
    if (r.status !== 200) { log.warn(`[XNXX] best HTTP ${r.status}`); return { items: [], hasNext: false }; }
    const items = parseListingHTML(r.data);
    return { items, hasNext: items.length >= 20 };
  } catch (e) {
    log.error(`[XNXX] best error: ${e.message}`);
    return { items: [], hasNext: false };
  }
}

/**
 * Detail 1 video: HLS (kualitas penuh) + mp4 360p (fallback) + metadata (pornstar, tag, deskripsi).
 * @returns {Promise<{title, thumb, videoUrl, hlsUrl, durationText, quality, pornstars, tags, uploader, description}|null>}
 */
async function scrapeDetail(detailUrl) {
  try {
    const r = await client.get(detailUrl);
    if (r.status !== 200) { log.warn(`[XNXX] detail HTTP ${r.status} ${detailUrl}`); return null; }
    const body = String(r.data);
    const $ = cheerio.load(body);

    const pick = (re) => { const m = body.match(re); return m ? m[1] : null; };
    const hlsUrl = pick(/setVideoHLS\('([^']+)'\)/);
    const high = pick(/setVideoUrlHigh\('([^']+)'\)/);
    const low = pick(/setVideoUrlLow\('([^']+)'\)/);
    const videoUrl = high || low; // mp4 progresif (umumnya max 360p)
    const title = decodeEntities(pick(/setVideoTitle\('([^']+)'\)/) || $('h1').first().text().trim() || 'Untitled');
    const thumb = pick(/setThumbUrl\('([^']+)'\)/);

    if (!hlsUrl && !videoUrl) {
      log.warn(`[XNXX] detail: tidak ada source video di ${detailUrl}`);
      return { title, thumb, videoUrl: null, hlsUrl: null, durationText: '', quality: '', pornstars: [], tags: [], uploader: null, description: '' };
    }

    // Pornstar / model (link /porn-maker/, /pornstar/, /model/)
    const pornstars = [];
    $('a[href^="/porn-maker/"], a[href^="/pornstar/"], a[href^="/model/"]').each((i, el) => {
      const name = decodeEntities($(el).text().trim());
      const slug = ($(el).attr('href') || '').replace(/^\/(porn-maker|pornstar|model)\//, '').replace(/\/$/, '');
      if (name && name.length >= 2 && !pornstars.some(p => p.slug === slug)) {
        pornstars.push({ name: name.slice(0, 40), slug });
      }
    });

    // Tag (link .is-keyword di .video-tags)
    const tags = [];
    $('.video-tags a.is-keyword, .video-tags a[href^="/search/"]').each((i, el) => {
      const t = decodeEntities($(el).text().trim());
      if (t && t.length >= 2 && !tags.includes(t)) tags.push(t);
    });

    // Metadata: channel/uploader, durasi, kualitas, deskripsi
    const metaTxt = $('.metadata').first().text().replace(/\s+/g, ' ').trim();
    const qM = metaTxt.match(/(\d{3,4}p)/i);
    const durM = metaTxt.match(/(\d+)\s*min/i) || metaTxt.match(/(\d+)\s*sec/i);
    const uploader = (metaTxt.split(/\d+\s*(?:min|sec)/i)[0] || '').trim().slice(0, 50) || null;
    const description = $('.metadata-row').first().text().replace(/\s+/g, ' ').trim().slice(0, 400);

    log.info(`[XNXX] detail: "${title.slice(0, 50)}" stars=${pornstars.length} tags=${tags.length} hls=${hlsUrl ? 'y' : 'n'}`);
    return {
      title, thumb, videoUrl, hlsUrl,
      durationText: durM ? durM[0].replace(/\s+/g, '') : '',
      quality: qM ? qM[1] : '',
      pornstars, tags: tags.slice(0, 12), uploader, description,
    };
  } catch (e) {
    log.error(`[XNXX] detail error: ${e.message}`);
    return null;
  }
}

/** HEAD untuk estimasi ukuran mp4 progresif. */
async function probeSourceSize(url) {
  try {
    const r = await axios.head(url, { headers: { 'User-Agent': UA, 'Referer': `${BASE_URL}/` }, timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) return null;
    return parseInt(r.headers['content-length'] || '0', 10) || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  scrapeSearch,
  scrapeBrowse,
  scrapeBest,
  scrapeDetail,
  probeSourceSize,
};
