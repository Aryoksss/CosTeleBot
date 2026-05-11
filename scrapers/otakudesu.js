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
const DOMAINS = () => {
  const env = process.env.OTAKUDESU_DOMAINS || process.env.OTAKUDESU_DOMAIN || '';
  if (env) return env.split(',').map(d => d.trim()).filter(Boolean);
  return ['https://otakudesu.fit', 'https://otakudesu.cloud', 'https://otakudesu.la', 'https://otakudesu.ro'];
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 12000, headers: { 'User-Agent': UA } });

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
 * Search anime by title.
 * @returns {Array<{title, slug, url, poster, status, type}>}
 */
async function search(query) {
  const { data, usedBase } = await fetchWithFallback(
    (base) => `${base}/?s=${encodeURIComponent(query)}`
  );
  const $ = cheerio.load(data);
  const results = [];

  // Otakudesu search results: div.listupd article or similar
  // Pattern: <article> with <a href> + <img> + title
  $('article, .bs, .bsx, .result-item, .chi_anime').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href*="/series/"]').first();
    if (!$a.length) return;
    const href = $a.attr('href') || '';
    const title = $a.attr('title') || $el.find('.tt, h2, h3, .title').first().text().trim() || $a.text().trim();
    const poster = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
    const status = $el.find('.status, .epx').text().trim() || '';
    const type = $el.find('.type, .typez').text().trim() || 'Anime';

    if (title && href) {
      results.push({
        title: title.replace(/\s+/g, ' ').trim(),
        slug: href.replace(/.*\/series\//, '').replace(/\/$/, ''),
        url: href,
        poster,
        status,
        type,
        source: 'otakudesu',
      });
    }
  });

  return results.slice(0, 15);
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

  // Episode list: table rows or list items with episode links
  $('a[href*="episode"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const text = $a.text().trim();
    // Filter only episode links (not series links)
    if (!href.includes('-episode-') && !href.includes('-ep-')) return;
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
 * Otakudesu terbaru pakai single Gofile link.
 * @param {string} episodeUrl - full URL or path
 * @returns {{gofileUrl: string|null, otherLinks: Array}}
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

  // Find all links in page
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('gofile.io/d/')) {
      gofileUrl = href;
    } else if (href.match(/acefile|akirabox|filedon|buzzheavier|mega\.nz|drive\.google/i)) {
      otherLinks.push({ host: href.match(/(acefile|akirabox|filedon|buzzheavier|mega|drive)/i)?.[1] || 'unknown', url: href });
    }
  });

  return { gofileUrl, otherLinks };
}

module.exports = { search, getEpisodes, getEpisodeDownload };
