'use strict';
/**
 * Otakudesu scraper — search anime + extract Gofile download link per episode.
 * Domain sering ganti, configurable via env OTAKUDESU_DOMAIN.
 * Pattern: WordPress site, search via ?s=<query>, episode page punya link Gofile.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = () => process.env.OTAKUDESU_DOMAIN || 'https://otakudesu.fit';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA } });

/**
 * Search anime by title.
 * @returns {Array<{title, slug, url, poster, status, type}>}
 */
async function search(query) {
  const url = `${BASE()}/?s=${encodeURIComponent(query)}`;
  const { data } = await http.get(url);
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
 * @returns {Array<{number, title, url}>}
 */
async function getEpisodes(seriesUrl) {
  const { data } = await http.get(seriesUrl);
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
 * @returns {{gofileUrl: string|null, otherLinks: Array}}
 */
async function getEpisodeDownload(episodeUrl) {
  const { data } = await http.get(episodeUrl);
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
