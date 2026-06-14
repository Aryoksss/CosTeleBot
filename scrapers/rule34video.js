'use strict';
/**
 * Rule34Video scraper — PURE AXIOS (tanpa Playwright).
 *
 * Dulu pakai persistent Chromium untuk memunculkan token `v-acctoken`, padahal
 * link download `get_file/...mp4/?v-acctoken=...` SUDAH ada di HTML statis detail
 * page. Jadi cukup axios + regex → jauh lebih cepat & hemat RAM (no browser).
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://rule34video.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const r34Axios = axios.create({
  headers: { 'User-Agent': UA, 'Referer': BASE_URL },
  timeout: 30000,
  validateStatus: () => true,
});

/**
 * Ambil daftar video dari halaman manapun (beranda/pencarian/latest).
 * @returns {Array<{title, link, thumb}>}
 */
async function parseVideoList(url) {
  try {
    const res = await r34Axios.get(url);
    if (res.status !== 200) { console.error(`[R34Video] list HTTP ${res.status} ${url}`); return []; }
    const $ = cheerio.load(res.data);
    const items = [];

    $('a[href*="/video/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href || !/\/video\/\d+/.test(href)) return;
      const title = $(el).attr('title') || $(el).text().trim().substring(0, 80);
      const img = $(el).find('img');
      const thumb = img.attr('data-original') || img.attr('data-src') || img.attr('src');
      if (href && title.length > 2) {
        items.push({
          title,
          link: href.startsWith('http') ? href : BASE_URL + href,
          thumb: thumb && thumb.startsWith('http') ? thumb : (thumb ? BASE_URL + thumb : null),
        });
      }
    });

    // Dedup by link
    const seen = new Set();
    return items.filter(v => { if (seen.has(v.link)) return false; seen.add(v.link); return true; });
  } catch (e) {
    console.error(`[R34Video] Error fetching: ${url} — ${e.message}`);
    return [];
  }
}

/**
 * Katalog video (pencarian / update terbaru).
 */
async function scrapeListing(page = 1, query = null) {
  const url = query
    ? `${BASE_URL}/search/${encodeURIComponent(query)}/${page > 1 ? '?from_videos=' + page : ''}`
    : `${BASE_URL}/latest-updates/${page}/`;
  return parseVideoList(url);
}

/**
 * Ambil semua link download `.mp4` (dengan v-acctoken) dari detail page — pure axios.
 * @returns {Array<{label, quality, url}>} diurutkan resolusi tertinggi ke terendah.
 */
async function scrapePostDetail(url) {
  try {
    const res = await r34Axios.get(url);
    if (res.status !== 200) { console.error(`[R34Video] detail HTTP ${res.status} ${url}`); return []; }
    const html = String(res.data);

    // URL download tertoken ada langsung di HTML (config player).
    const tokenized = html.match(/https?:\/\/[^\s"'<>\\]*get_file[^\s"'<>\\]*v-acctoken=[^\s"'<>\\]+/gi) || [];

    // Satu URL per kualitas (resolusi dari nama file: _1080p.mp4 / _360.mp4).
    const byQuality = new Map();
    for (const u of [...new Set(tokenized)]) {
      const q = (u.match(/_(\d{3,4})p?\.mp4/i) || [])[1];
      if (q && !byQuality.has(q)) byQuality.set(q, u);
    }

    const order = ['1080', '720', '480', '360'];
    const downloads = [...byQuality.entries()]
      .map(([q, u]) => ({ label: `MP4 ${q}p`, quality: q, url: u }))
      .sort((a, b) => {
        const ai = order.indexOf(a.quality); const bi = order.indexOf(b.quality);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    console.log(`[R34Video] ${downloads.length} link download dari ${url}`);
    return downloads;
  } catch (e) {
    console.error(`[R34Video] Error detail: ${url} — ${e.message}`);
    return [];
  }
}

module.exports = {
  scrapeListing,
  scrapePostDetail,
  parseVideoList,
};
