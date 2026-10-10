'use strict';
/**
 * Otakudesu scraper — search anime + extract Gofile download link per episode.
 * Domain sering ganti, configurable via env OTAKUDESU_DOMAINS (CSV, multiple fallback).
 * Bot coba domain pertama, kalau gagal (timeout/error) otomatis fallback ke berikutnya.
 * Pattern: WordPress site, search via ?s=<query>, episode page punya link Gofile.
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Support multiple domains (CSV). Coba dari kiri ke kanan sampai ada yang respond.
// .blog = layout KLASIK (punya section download multi-host) → diprioritaskan untuk
// download. .fit/.la = layout modern (katalog lebih lengkap, tapi streaming-only).
const DOMAINS = () => {
  const env = process.env.OTAKUDESU_DOMAINS || process.env.OTAKUDESU_DOMAIN || '';
  if (env) return env.split(',').map(d => d.trim()).filter(Boolean);
  return ['https://otakudesu.blog', 'https://otakudesu.fit', 'https://otakudesu.la'];
};

const UA = require('../utils/ua').UA;

const http = axios.create({ timeout: 12000, headers: { 'User-Agent': UA } });

/**
 * Resolve redirector link.desustream.com (302) → URL host asli (gofile/mega/dll).
 * Kalau bukan desustream, kembalikan apa adanya.
 */
async function resolveDesustream(url) {
  if (!url || !/desustream\.com/i.test(url)) return url;
  try {
    const res = await http.get(url, { maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
    return res.headers['location'] || null;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) return e.response.headers.location;
    return null;
  }
}

/**
 * Try GET request across multiple domains. Returns first successful response.
 * @param {string} pathFn - function(base) => full URL
 * @returns {{data, usedBase}} or throws if all fail
 */
async function fetchWithFallback(pathFn) {
  const domains = DOMAINS();
  let lastErr = null;
  for (const base of domains) {
    try {
      const url = pathFn(base);
      const res = await http.get(url);
      return { data: res.data, usedBase: base };
    } catch (err) {
      lastErr = err;
      // Continue to next domain
    }
  }
  throw lastErr || new Error('All Otakudesu domains failed');
}

/**
 * Search anime by title across all domains.
 * Unlike fetchWithFallback (which stops at first HTTP success), search tries ALL domains
 * and merges results — because different domains have different catalogs.
 * @returns {Array<{title, slug, url, poster, status, type}>}
 */
async function search(query) {
  const domains = DOMAINS();
  const allResults = [];

  // Try all domains in parallel for speed
  const responses = await Promise.allSettled(
    domains.map(base => http.get(`${base}/?s=${encodeURIComponent(query)}`))
  );

  for (const res of responses) {
    if (res.status !== 'fulfilled') continue;
    const $ = cheerio.load(res.value.data);

    // --- Modern layout (.fit): <article> with a[href*="/series/"] ---
    $('article, .bs, .bsx, .result-item, .chi_anime').each((_, el) => {
      const $el = $(el);
      const $a = $el.find('a[href*="/series/"]').first();
      if (!$a.length) return;
      const href = $a.attr('href') || '';
      const title = $a.attr('title') || $el.find('.tt, h2, h3, .title').first().text().trim() || $a.text().trim();
      const poster = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
      const status = $el.find('.status, .epx').text().trim() || '';

      if (title && href) {
        allResults.push({
          title: title.replace(/\s+/g, ' ').trim(),
          slug: href.replace(/.*\/series\//, '').replace(/\/$/, ''),
          url: href,
          poster,
          status,
          type: 'Anime',
          source: 'otakudesu',
        });
      }
    });

    // --- Classic layout (.blog): <ul class="chivsrc"><li> with a[href*="/anime/"] ---
    $('ul.chivsrc li, .chivsrc li').each((_, el) => {
      const $el = $(el);
      // Find series/anime link (not episode/batch links)
      const $a = $el.find('a[href*="/anime/"]').first();
      if (!$a.length) return;
      const href = $a.attr('href') || '';
      const title = $a.text().trim()
        .replace(/\s*Subtitle Indonesia$/i, '')
        .replace(/\s*\(Episode.*?\)$/i, '');
      const poster = $el.find('img').first().attr('src') || '';
      const statusText = $el.find('.set').filter((_, s) => $(s).text().includes('Status')).text().replace(/.*Status\s*:\s*/i, '').trim();

      if (title && href) {
        allResults.push({
          title: title.replace(/\s+/g, ' ').trim(),
          slug: href.replace(/.*\/anime\//, '').replace(/\/$/, ''),
          url: href,
          poster,
          status: statusText || '',
          type: 'Anime',
          source: 'otakudesu',
        });
      }
    });
  }

  // Dedupe by normalized title
  const seen = new Set();
  const unique = [];
  for (const r of allResults) {
    const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique.slice(0, 15);
}

/**
 * Get episode list from series page.
 * @param {string} seriesUrl - full URL or slug path
 * @returns {Array<{number, title, url}>}
 */
async function getEpisodes(seriesUrl) {
  // seriesUrl might be full URL with a specific domain, or relative
  // Try the URL as-is first, then fallback to other domains
  let data;
  try {
    const res = await http.get(seriesUrl);
    data = res.data;
  } catch (_) {
    // Extract path from URL and try with fallback domains
    const urlPath = seriesUrl.replace(/^https?:\/\/[^/]+/, '');
    const result = await fetchWithFallback((base) => `${base}${urlPath}`);
    data = result.data;
  }
  const $ = cheerio.load(data);
  const episodes = [];

  // Episode list: links containing "episode" in href
  // Modern (.fit): href like "/one-piece-episode-1161-subtitle-indonesia/"
  // Classic (.blog): href like "/episode/wpoiec-episode-1161-sub-indo/"
  $('a[href*="episode"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const text = $a.text().trim();
    // Filter: must contain "episode" pattern in path (not just query params)
    if (!href.match(/episode[_\-/]/i)) return;
    // Skip if it's a series/anime link (not episode)
    if (href.includes('/series/') || href.includes('/anime/')) return;
    // Skip pembatas/placeholder (mis. "...episode-1-900-dalam-proses", batch divider)
    if (/pembatas|dalam-proses|dalam_proses/i.test(href)) return;
    // Extract episode number from text or URL
    const numMatch = text.match(/(?:Episode|Eps?)\s*(\d+)/i) || href.match(/episode[_-]?(\d+)/i);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;
    if (num > 0 && !episodes.find(e => e.number === num)) {
      episodes.push({ number: num, title: text, url: href });
    }
  });

  // Sort ascending
  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

/**
 * Extract download link from episode page.
 * Supports 2 layouts:
 *   - Modern (.fit): single Gofile link
 *   - Classic (.blog): <div class="download"> with multi-host (ZippyShare/LetsUp/Racaty/Mega) per quality
 * @param {string} episodeUrl - full URL or path
 * @returns {{gofileUrl: string|null, qualityLinks: Array<{quality, links: [{host, url}]}>, otherLinks: Array}}
 */
async function getEpisodeDownload(episodeUrl) {
  let data;
  try {
    const res = await http.get(episodeUrl);
    data = res.data;
  } catch (_) {
    const urlPath = episodeUrl.replace(/^https?:\/\/[^/]+/, '');
    const result = await fetchWithFallback((base) => `${base}${urlPath}`);
    data = result.data;
  }
  const $ = cheerio.load(data);

  let gofileUrl = null;
  const otherLinks = [];
  const qualityLinks = [];

  // --- Modern (.fit) pattern: scan all links for Gofile ---
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('gofile.io/d/')) {
      gofileUrl = href;
    } else if (href.match(/acefile|akirabox|filedon|buzzheavier|mega\.nz|drive\.google/i)) {
      otherLinks.push({ host: href.match(/(acefile|akirabox|filedon|buzzheavier|mega|drive)/i)?.[1] || 'unknown', url: href });
    }
  });

  // --- Classic (.blog) pattern: <div class="download"><ul><li><strong>QUALITY</strong><a>HOST</a>...</li></ul></div> ---
  $('.download ul li').each((_, li) => {
    const $li = $(li);
    const quality = $li.find('strong').first().text().trim() || 'Unknown';
    const links = [];
    $li.find('a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const host = $a.text().trim();
      if (href && host) links.push({ host, url: href });
    });
    if (links.length) qualityLinks.push({ quality, links });
  });

  // --- Classic links umumnya redirector link.desustream.com → resolve ke URL host asli. ---
  // Strategi: ambil GoFile resolusi TERTINGGI sebagai gofileUrl (jalur paling andal),
  // dan resolve link Mega per-kualitas supaya tombol Mega tetap berfungsi.
  if (!gofileUrl && qualityLinks.length) {
    let bestGofile = null, bestRes = -1;
    for (const q of qualityLinks) {
      const res = parseInt((String(q.quality).match(/(\d{3,4})/) || [])[1] || '0', 10);
      const gf = q.links.find(l => /gofile/i.test(l.host));
      if (gf && res >= bestRes) { bestRes = res; bestGofile = gf.url; }
    }
    if (bestGofile) {
      const real = await resolveDesustream(bestGofile);
      if (real && /gofile\.io/i.test(real)) gofileUrl = real;
    }
    // Resolve link Mega (paralel) untuk fallback tombol Mega.
    await Promise.all(qualityLinks.map(async (q) => {
      const mega = q.links.find(l => /mega/i.test(l.host));
      if (mega) {
        const real = await resolveDesustream(mega.url);
        if (real && /mega\.(nz|co\.nz)/i.test(real)) mega.url = real;
      }
    }));
  }

  return { gofileUrl, qualityLinks, otherLinks };
}

/**
 * Ambil daftar rilis episode terbaru dari homepage Otakudesu.
 * Dipakai oleh watcher auto-notify (deteksi episode baru).
 * @returns {Array<{title, episode, url, thumb, date, uid, source}>}
 */
async function getLatestReleases() {
  const { data } = await fetchWithFallback((base) => `${base}/`);
  const $ = cheerio.load(data);
  const items = [];
  const seen = new Set();

  $('.venz ul li .detpost').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.thumb a').first();
    const url = a.attr('href');
    if (!url || seen.has(url)) return;

    const title = $el.find('.jdlflm').text().trim();
    const episode = $el.find('.epz').text().replace(/\s+/g, ' ').trim(); // "Episode 10"
    const date = $el.find('.newnime').text().trim();
    const thumb = $el.find('img').first().attr('src') || null;
    if (!title) return;

    seen.add(url);
    items.push({
      title,
      episode,
      url,
      thumb,
      date,
      // uid unik per (series + episode) → episode baru memicu notif walau series sama.
      uid: `${url}#${episode}`,
      source: 'otakudesu',
    });
  });

  return items;
}

module.exports = { search, getEpisodes, getEpisodeDownload, getLatestReleases };
