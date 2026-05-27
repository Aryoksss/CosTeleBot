'use strict';
/**
 * Nekopoi.care scraper — browse/search hentai/JAV, download via embed player HLS.
 *
 * Flow:
 *   1. Search/browse → list post (title, thumb, URL)
 *   2. Detail → extract embed player URLs (streampoi, playmogo, dll)
 *   3. Playwright navigate ke embed → intercept .m3u8
 *   4. ffmpeg download HLS → send to Telegram
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

const BASE = () => process.env.NEKOPOI_BASE_URL || 'https://nekopoi.care';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA } });

// Categories available
const CATEGORIES = {
  hentai: '/category/hentai/',
  jav: '/category/jav/',
  'jav-cosplay': '/category/jav-cosplay/',
  '2d': '/category/2d-animation/',
  '3d': '/category/3d-hentai/',
};

// ─── SCRAPING ─────────────────────────────────────────────────────────────────

/**
 * Parse post list from a cheerio-loaded page.
 */
function parsePostList($, base) {
  const posts = [];
  // Main content cards: .nk-hentai-grid .nk-post-card or .nk-jav-grid items
  $('article.nk-post-card, .nk-hentai-grid article, .nk-jav-grid article, h2.entry-title').each((i, el) => {
    let title, link, thumb;

    if ($(el).is('h2')) {
      // Fallback: h2.entry-title
      const a = $(el).find('a').first();
      link = a.attr('href');
      title = a.text().trim();
      thumb = null;
    } else {
      const a = $(el).find('.nk-post-thumb a, h2 a, h3 a, .entry-title a').first();
      link = a.attr('href') || $(el).find('a').first().attr('href');
      title = $(el).find('h2, h3, .nk-post-title, .entry-title').first().text().trim()
        || $(el).find('a').first().attr('title') || '';
      thumb = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null;
    }

    if (!link || !title) return;
    // Skip category/page links
    if (link.match(/\/category\/|\/page\/|\/hentai-list|\/jav-list|\/genre-list/)) return;

    posts.push({ title, url: link, thumb, source: 'nekopoi' });
  });
  return posts;
}

/**
 * Browse by category.
 * @param {'hentai'|'jav'|'jav-cosplay'|'2d'|'3d'} category
 * @param {number} page
 */
async function browse(category = 'hentai', page = 1) {
  const base = BASE();
  const catPath = CATEGORIES[category] || CATEGORIES.hentai;
  const url = page > 1 ? `${base}${catPath}page/${page}/` : `${base}${catPath}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  return parsePostList($, base);
}

/**
 * Search posts.
 * @param {string} query
 * @param {number} page
 */
async function search(query, page = 1) {
  const base = BASE();
  const url = page > 1
    ? `${base}/page/${page}/?s=${encodeURIComponent(query)}`
    : `${base}/?s=${encodeURIComponent(query)}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  // If no results, try category-level titles
  const posts = parsePostList($, base);

  // Fallback: grab h2/h3 links from search results
  if (posts.length === 0) {
    $('h2 a, h3 a, .entry-title a').each((i, el) => {
      const link = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!link || link.match(/\/category\/|\/page\/|\/hentai-list|\/jav-list/)) return;
      posts.push({ title, url: link, thumb: null, source: 'nekopoi' });
    });
  }
  return posts;
}

/**
 * Get detail page: extract embed player URLs + mirror links.
 * @param {string} url - full post URL
 * @returns {{ title, thumb, synopsis, embeds: string[], mirrors: string[] }}
 */
async function getDetail(url) {
  const { data } = await http.get(url, { headers: { 'Referer': BASE() } });
  const $ = cheerio.load(data);

  const title = $('h1.entry-title, h1.post-title, h2.entry-title, h1').first().text().trim()
    || $('title').text().replace('– NekoPoi', '').trim();
  const thumb = $('meta[property="og:image"]').attr('content')
    || $('.post-thumbnail img, .entry-thumbnail img').attr('src') || null;
  const synopsis = $('.entry-content p, .post-content p').first().text().trim().slice(0, 300);

  // Extract iframe embed URLs
  const embeds = [];
  $('iframe[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src && (src.includes('streampoi') || src.includes('playmogo') ||
                src.includes('embed') || src.includes('player') || src.includes('stream'))) {
      embeds.push(src.startsWith('//') ? `https:${src}` : src);
    }
  });

  // Also check data-src
  $('iframe[data-src]').each((i, el) => {
    const src = $(el).attr('data-src');
    if (src) embeds.push(src.startsWith('//') ? `https:${src}` : src);
  });

  // Extract mirror download links (ouo.io, etc.)
  const mirrors = [];
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.includes('ouo.io') || href.includes('short') ||
        text.match(/mirror|download|480p|720p|1080p/i)) {
      mirrors.push({ label: text.slice(0, 40), url: href });
    }
  });

  return { title, thumb, synopsis, embeds, mirrors };
}

// ─── PLAYWRIGHT HLS INTERCEPTION ─────────────────────────────────────────────

/**
 * Intercept .m3u8 from embed player URLs.
 * Tries each embed in order, returns first found m3u8.
 *
 * @param {string[]} embedUrls
 * @param {string} postUrl - original post URL for Referer
 * @param {function(string)} onLog
 * @returns {Promise<{m3u8Url, headers, subtitleUrls}>}
 */
async function interceptM3u8(embedUrls, postUrl, onLog = () => {}) {
  if (!embedUrls || embedUrls.length === 0) {
    throw new Error('Tidak ada embed player di halaman ini');
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    for (const embedUrl of embedUrls) {
      onLog(`[info] Trying embed: ${embedUrl.slice(0, 80)}...`);

      let context;
      try {
        context = await browser.newContext({
          userAgent: UA,
          ignoreHTTPSErrors: true,
          bypassCSP: true,
          extraHTTPHeaders: { 'Referer': postUrl },
        });

        const page = await context.newPage();
        const m3u8Urls = [];
        const subtitleUrls = [];
        const capturedHeaders = {};

        await page.route('**/*', async (route) => {
          const url = route.request().url();
          if (url.includes('.m3u8')) {
            if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
            const hdrs = route.request().headers();
            capturedHeaders.referer = hdrs.referer || hdrs['Referer'] || embedUrl;
            capturedHeaders.origin = hdrs.origin || hdrs['Origin'] || new URL(embedUrl).origin;
            capturedHeaders.userAgent = hdrs['user-agent'] || UA;
          }
          if (url.includes('.vtt') || url.includes('.srt') || url.includes('subtitle') || url.includes('caption')) {
            if (!subtitleUrls.includes(url)) subtitleUrls.push(url);
          }
          await route.continue().catch(() => {});
        });

        try {
          await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } catch (e) {
          onLog(`[warn] Nav error: ${e.message.slice(0, 60)}`);
          await context.close();
          continue;
        }

        await page.waitForTimeout(3000);

        // Click play buttons
        const clickPlay = async () => {
          for (const sel of [
            'video', '.vjs-big-play-button', '.jw-icon-display', '.jw-display-icon-container',
            '#play-button', '.play-button', '[class*="play"]', 'button[aria-label="Play"]',
            '.plyr__control--overlaid', '[data-plyr="play"]',
          ]) {
            try {
              const el = await page.$(sel);
              if (el) { await el.click().catch(() => {}); break; }
            } catch (_) {}
          }
          // Also try programmatic play
          await page.evaluate(() => {
            document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
          }).catch(() => {});
        };

        await clickPlay();

        // Wait up to 30s for m3u8
        const deadline = Date.now() + 30000;
        while (m3u8Urls.length === 0 && Date.now() < deadline) {
          await page.waitForTimeout(2000);
          await clickPlay();
        }

        if (m3u8Urls.length > 0) {
          const bestUrl = m3u8Urls.find(u => u.includes('master')) ||
                          m3u8Urls.find(u => !u.includes('/seg') && !u.includes('/chunk')) ||
                          m3u8Urls[0];
          onLog(`[info] Found .m3u8: ${bestUrl.slice(0, 100)}`);
          if (subtitleUrls.length > 0) onLog(`[info] Found ${subtitleUrls.length} subtitle(s)`);
          await context.close();
          return {
            m3u8Url: bestUrl,
            headers: {
              referer: capturedHeaders.referer || embedUrl,
              origin: capturedHeaders.origin || new URL(embedUrl).origin,
              userAgent: capturedHeaders.userAgent || UA,
            },
            subtitleUrls,
          };
        }

        onLog(`[warn] No .m3u8 from ${embedUrl.slice(0, 60)}`);
        await context.close();
      } catch (err) {
        onLog(`[warn] Error: ${err.message.slice(0, 80)}`);
        if (context) await context.close().catch(() => {});
      }
    }

    throw new Error('Tidak dapat menemukan stream HLS dari semua embed player. Coba video lain.');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── FFMPEG DOWNLOAD ─────────────────────────────────────────────────────────

/**
 * Check if ffmpeg is available.
 */
function checkFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0;
}

/**
 * Download HLS stream via ffmpeg.
 */
function downloadHls(m3u8Url, outputPath, headers = {}, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const headerParts = [];
    if (headers.referer) headerParts.push(`Referer: ${headers.referer}`);
    if (headers.origin) headerParts.push(`Origin: ${headers.origin}`);
    headerParts.push(`User-Agent: ${headers.userAgent || UA}`);

    const args = [
      '-y',
      '-headers', headerParts.join('\r\n'),
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-timeout', '30000000',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      outputPath,
    ];

    onLog('[ffmpeg] Starting HLS download...');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastLine = '';
    let duration = 0;

    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
        lastLine = line;
        const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durMatch) duration = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];

        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch && duration > 0) {
          const cur = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
          const pct = Math.min(99, Math.round((cur / duration) * 100));
          const sz = (line.match(/size=\s*([\d]+\w*)/) || [])[1] || '?';
          const sp = (line.match(/speed=([\d.]+x)/) || [])[1] || '?';
          onLog(`[download] ${pct}% | size=${sz} | speed=${sp}`);
        }
      }
    });
    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${lastLine.slice(0, 200)}`));
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
        return reject(new Error('ffmpeg selesai tapi file kosong'));
      }
      onLog('[ffmpeg] Download complete!');
      resolve(outputPath);
    });

    proc.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('ffmpeg timeout (30 menit)'));
    }, 30 * 60 * 1000);
  });
}

/**
 * Full download pipeline: detail scrape → Playwright intercept → ffmpeg.
 *
 * @param {string} postUrl - nekopoi post URL
 * @param {string} outputPath - destination path (without .mp4)
 * @param {function(string)} onLog
 * @returns {Promise<string>} mp4 file path
 */
async function downloadFromNekopoi(postUrl, outputPath, onLog = () => {}) {
  // Step 1: Get embed URLs from post
  onLog('[info] Mengambil detail post...');
  const detail = await getDetail(postUrl);

  if (detail.embeds.length === 0) {
    throw new Error('Tidak ada embed player di post ini. Coba post lain.');
  }

  onLog(`[info] Found ${detail.embeds.length} embed(s). Launching browser...`);

  // Step 2: Intercept .m3u8
  const { m3u8Url, headers } = await interceptM3u8(detail.embeds, postUrl, onLog);

  // Step 3: Download via ffmpeg
  onLog('[info] Stream found! Downloading via ffmpeg...');
  const mp4Path = `${outputPath}.mp4`;
  return await downloadHls(m3u8Url, mp4Path, headers, onLog);
}

module.exports = {
  browse,
  search,
  getDetail,
  downloadFromNekopoi,
  interceptM3u8,
  checkFfmpeg,
  CATEGORIES,
};
