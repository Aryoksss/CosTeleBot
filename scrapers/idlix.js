'use strict';
/**
 * IDLIX scraper — search & stream film/series dari IDLIX WordPress site.
 *
 * Flow:
 *   1. Search: WordPress search (?s=query) → parse hasil dengan cheerio
 *   2. Detail: Buka halaman film → extract iframe embed (vidhide.org/filemoon/dll)
 *   3. Stream: Playwright navigate ke embed → intercept .m3u8
 *   4. Download: ffmpeg -i <m3u8_url> -c copy output.mp4
 *   5. Subtitle: intercept .vtt/.srt dari player + fallback OpenSubtitles
 *
 * Requires on VPS:
 *   apt install ffmpeg
 *   npx playwright install chromium
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

// IDLIX site base URLs — search across multiple mirrors for wider catalog
// CSV via env, or defaults. First hit wins.
const IDLIX_BASES = () => {
  const env = process.env.IDLIX_BASE_URL || '';
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return ['https://159.65.50.100', 'https://pafisangirjujuan.org'];
};

// OpenSubtitles API (free tier fallback for subtitles)
const OPENSUB_BASE = 'https://api.opensubtitles.com/api/v1';
const OPENSUB_KEY = () => process.env.OPENSUBTITLES_API_KEY || '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': UA },
  // IDLIX site kadang pakai self-signed cert
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
});

// ─── SEARCH & BROWSE ──────────────────────────────────────────────────────────

/**
 * Search film/series di semua IDLIX mirrors, merge results (deduplicate by slug).
 * @param {string} query
 * @returns {Array<{title, url, slug, year, type, poster, quality, rating}>}
 */
async function search(query) {
  const bases = IDLIX_BASES();
  const allResults = [];
  const seenSlugs = new Set();

  // Query all mirrors in parallel
  const promises = bases.map(async (base) => {
    try {
      const { data } = await http.get(`${base}/`, { params: { s: query } });
      const $ = cheerio.load(data);

      $('article.item, article.has-post-thumbnail').each((i, el) => {
        const $el = $(el);
        const link = $el.find('h2.entry-title a, .content-thumbnail > a').first();
        const href = link.attr('href') || '';
        const title = link.attr('title')?.replace(/^Permalink (?:ke|to):\s*/i, '').trim() ||
                      link.text().trim() ||
                      $el.find('h2.entry-title').text().trim();
        if (!href || !title) return;

        const slug = href.replace(/https?:\/\/[^/]+\//, '').replace(/\/$/, '');
        if (seenSlugs.has(slug)) return; // deduplicate across mirrors
        seenSlugs.add(slug);

        const poster = $el.find('img.wp-post-image').attr('src') || null;
        const rating = $el.find('.gmr-rating-item').text().replace(/[^\d.]/g, '') || '';
        const duration = $el.find('.gmr-duration-item').text().trim() || '';
        const type = $el.attr('itemtype')?.includes('TVSeries') ? 'tv' : 'movie';
        const year = title.match(/\((\d{4})\)/)?.[1] || slug.match(/(\d{4})/)?.[1] || '';

        allResults.push({
          title: title.replace(/\s*\(\d{4}\)\s*$/, '').trim() || title,
          url: href,
          slug,
          year,
          type,
          poster,
          quality: '',
          rating,
          duration,
          source: 'idlix',
        });
      });
    } catch (err) {
      // Mirror down — skip silently
    }
  });

  await Promise.all(promises);
  return allResults.slice(0, 15);
}

/**
 * Get detail halaman film: extract embed iframe URL + info.
 * @param {string} url - full URL halaman film di IDLIX
 * @returns {{title, embedUrl, year, duration, genre, synopsis, poster}}
 */
async function getDetail(url) {
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const title = $('h1.entry-title, h1.wp-title, .sheader .data h1, h1').first().text().trim() || 'Unknown';
  const synopsis = $('.synp, .entry-content p, .wp-content p, .desc, .storyline').first().text().trim().slice(0, 300);
  const poster = $('meta[property="og:image"]').attr('content') || $('img.wp-post-image').attr('src') || null;
  const year = $('meta[property="og:updated_time"], .extra .date, .sheader .date').text().match(/\d{4}/)?.[0] || '';
  const duration = $('.runtime, .duration, .tmdb_runtime').text().trim() || '';
  const genre = $('.sgeneros a, .genre a').map((i, el) => $(el).text().trim()).get().join(', ');

  // Extract embed iframe URL
  let embedUrl = null;
  $('iframe').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    // Skip non-player iframes (ads, analytics)
    if (src.includes('vidhide') || src.includes('filemoon') || src.includes('streamwish') ||
        src.includes('doodstream') || src.includes('upstream') || src.includes('mixdrop') ||
        src.includes('embed') || src.includes('player')) {
      embedUrl = src.startsWith('//') ? `https:${src}` : src;
      return false; // break
    }
  });

  // Fallback: cari di script tags (beberapa theme simpan embed URL di JS)
  if (!embedUrl) {
    const scriptContent = $('script').map((i, el) => $(el).html()).get().join('\n');
    const embedMatch = scriptContent.match(/(?:src|url|embed)['":\s]*['"]?(https?:\/\/(?:vidhide|filemoon|streamwish|doodstream|upstream|mixdrop)[^'"\s]+)/i);
    if (embedMatch) embedUrl = embedMatch[1];
  }

  return { title, embedUrl, year, duration, genre, synopsis, poster };
}

/**
 * Get episode list for a TV series page.
 * @param {string} url - URL halaman series
 * @returns {{seasons: [{number, episodes: [{number, title, url}]}]}}
 */
async function getSeriesEpisodes(url) {
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const seasons = [];

  // Common IDLIX theme: .bixbox with season tabs, episodes as list
  $('.se-c, .season-list, [data-season]').each((i, el) => {
    const seasonNum = $(el).find('.se-t, .title').text().match(/\d+/)?.[0] || String(i + 1);
    const episodes = [];

    $(el).find('.episodios li a, .eps-list a, .episode-item a, ul li a').each((j, epEl) => {
      const epUrl = $(epEl).attr('href') || '';
      const epTitle = $(epEl).text().trim();
      const epNum = epTitle.match(/(?:ep|episode|eps)[\s.]*(\d+)/i)?.[1] || String(j + 1);
      if (epUrl) episodes.push({ number: parseInt(epNum), title: epTitle, url: epUrl });
    });

    if (episodes.length > 0) {
      seasons.push({ number: parseInt(seasonNum), episodes });
    }
  });

  return { seasons };
}

// ─── PLAYWRIGHT HLS INTERCEPTION ─────────────────────────────────────────────

/**
 * Check if ffmpeg is available.
 */
function checkFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
  return result.status === 0;
}

/**
 * Intercept HLS .m3u8 URL + subtitle from embed player via Playwright.
 * Navigate directly to the embed URL (vidhide.org, filemoon, etc.) and intercept.
 *
 * @param {string} embedUrl - direct embed player URL (e.g. https://vidhide.org/embed/xxx)
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<{m3u8Url: string, headers: object, subtitleUrls: string[]}>}
 */
async function interceptM3u8(embedUrl, onLog = () => {}) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--ignore-certificate-errors',
      ],
    });

    onLog(`[info] Opening embed player: ${embedUrl.slice(0, 80)}...`);

    const context = await browser.newContext({
      userAgent: UA,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });

    const page = await context.newPage();

    // Intercept ALL network requests
    const m3u8Urls = [];
    const subtitleUrls = [];
    const capturedHeaders = {};

    await page.route('**/*', async (route) => {
      const url = route.request().url();

      if (url.includes('.m3u8')) {
        if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
        const hdrs = route.request().headers();
        capturedHeaders.referer = hdrs.referer || hdrs['Referer'] || '';
        capturedHeaders.origin = hdrs.origin || hdrs['Origin'] || '';
        capturedHeaders.userAgent = hdrs['user-agent'] || UA;
      }

      if (url.includes('.vtt') || url.includes('.srt') || url.includes('subtitle') || url.includes('caption')) {
        if (!subtitleUrls.includes(url)) subtitleUrls.push(url);
      }

      await route.continue().catch(() => {});
    });

    // Navigate to embed
    try {
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      throw new Error(`Gagal buka embed player: ${navErr.message.slice(0, 100)}`);
    }

    // Wait for page to load
    await page.waitForTimeout(3000);

    // Click play button in all frames
    const clickPlay = async () => {
      const allFrames = page.frames();
      for (const frame of allFrames) {
        try {
          const playSelectors = [
            '#fakePlayButton', '.play-button', '#play-button',
            'button[aria-label="Play"]', '.jw-icon-display', '.vjs-big-play-button',
            '.plyr__control--overlaid', '[data-plyr="play"]',
            '.vjs-play-control', '#player', '.player-play',
            '[class*="play"]', 'video',
          ];
          for (const sel of playSelectors) {
            const btn = await frame.$(sel);
            if (btn) {
              await btn.click().catch(() => {});
              onLog(`[info] Clicked: ${sel}`);
              return true;
            }
          }
        } catch (_) {}
      }
      return false;
    };

    await clickPlay();

    // Wait for .m3u8 to appear (up to 35 seconds — VidHide can be slow)
    const deadline = Date.now() + 35000;
    while (m3u8Urls.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(2000);
      await clickPlay();
    }

    await context.close();

    if (m3u8Urls.length === 0) {
      throw new Error('Tidak ditemukan stream .m3u8 dari embed player. Player mungkin butuh CAPTCHA atau geo-blocked.');
    }

    // Prefer master playlist
    let bestUrl = m3u8Urls.find(u => u.includes('master')) ||
                  m3u8Urls.find(u => !u.includes('/seg') && !u.includes('/chunk')) ||
                  m3u8Urls[0];

    onLog(`[info] Found .m3u8: ${bestUrl.slice(0, 100)}...`);
    if (subtitleUrls.length > 0) {
      onLog(`[info] Found ${subtitleUrls.length} subtitle track(s)`);
    }

    return {
      m3u8Url: bestUrl,
      headers: {
        referer: capturedHeaders.referer || embedUrl,
        origin: capturedHeaders.origin || new URL(embedUrl).origin,
        userAgent: capturedHeaders.userAgent || UA,
      },
      subtitleUrls,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── SUBTITLE ─────────────────────────────────────────────────────────────────

/**
 * Download subtitle file to local path.
 * @param {string} url
 * @param {string} destPath - base path (without extension)
 * @param {function(string)} onLog
 * @returns {Promise<string|null>} local path or null
 */
async function downloadSubtitle(url, destPath, onLog = () => {}) {
  try {
    const ext = url.includes('.vtt') ? '.vtt' : '.srt';
    const subPath = `${destPath}${ext}`;
    const { data } = await axios.get(url, {
      timeout: 15000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA },
    });
    fs.writeFileSync(subPath, data);
    onLog(`[subtitle] Downloaded: ${(Buffer.byteLength(data) / 1024).toFixed(1)} KB`);
    return subPath;
  } catch (err) {
    onLog(`[subtitle] Download gagal: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Fetch Indonesian subtitle from OpenSubtitles API (fallback).
 * @param {string} title - film title for search
 * @param {function(string)} onLog
 * @returns {Promise<string|null>} download URL or null
 */
async function fetchOpenSubtitlesId(title, onLog = () => {}) {
  try {
    const headers = { 'User-Agent': 'CosTeleBot v1.0', 'Accept': 'application/json' };
    const apiKey = OPENSUB_KEY();
    if (apiKey) headers['Api-Key'] = apiKey;

    const { data } = await http.get(`${OPENSUB_BASE}/subtitles`, {
      params: { query: title, languages: 'id', order_by: 'download_count', order_direction: 'desc' },
      headers,
      timeout: 10000,
    });

    if (!data.data || data.data.length === 0) {
      onLog('[subtitle] Tidak ada subtitle Indonesia di OpenSubtitles');
      return null;
    }

    const best = data.data[0];
    const fileId = best.attributes?.files?.[0]?.file_id;
    if (!fileId) return null;

    onLog(`[subtitle] Found: "${best.attributes?.release || 'unknown'}" (${best.attributes?.download_count || 0} downloads)`);

    const { data: dlData } = await http.post(`${OPENSUB_BASE}/download`,
      { file_id: fileId },
      { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    return dlData.link || null;
  } catch (err) {
    onLog(`[subtitle] OpenSubtitles error: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Get Indonesian subtitle: from player intercept first, then OpenSubtitles fallback.
 * @param {string[]} interceptedUrls
 * @param {string} title - film title
 * @param {string} destPath - base path for saving
 * @param {function(string)} onLog
 * @returns {Promise<string|null>}
 */
async function getIndonesianSubtitle(interceptedUrls, title, destPath, onLog = () => {}) {
  // VidHide biasanya serve subtitle Indonesia langsung (lihat meta description)
  // Try intercepted URLs first
  const idPatterns = [/[/.]id[./]/, /[/.]ind[./]/, /indonesi/i, /lang=id/i, /bahasa/i];

  for (const url of interceptedUrls) {
    if (idPatterns.some(p => p.test(url))) {
      onLog(`[subtitle] Found Indonesian from player`);
      const result = await downloadSubtitle(url, destPath, onLog);
      if (result) return result;
    }
  }

  // If only 1 subtitle (likely Indonesian on IDLIX)
  if (interceptedUrls.length === 1) {
    onLog(`[subtitle] Trying single subtitle from player (likely Indonesian)`);
    const result = await downloadSubtitle(interceptedUrls[0], destPath, onLog);
    if (result) return result;
  }

  // Fallback: OpenSubtitles
  onLog('[subtitle] Mencari subtitle di OpenSubtitles...');
  const osUrl = await fetchOpenSubtitlesId(title, onLog);
  if (osUrl) {
    const result = await downloadSubtitle(osUrl, destPath, onLog);
    if (result) return result;
  }

  // Try all intercepted
  if (interceptedUrls.length > 1) {
    for (const url of interceptedUrls) {
      const result = await downloadSubtitle(url, destPath, onLog);
      if (result) return result;
    }
  }

  onLog('[subtitle] Tidak ada subtitle Indonesia tersedia');
  return null;
}

// ─── FFMPEG DOWNLOAD ──────────────────────────────────────────────────────────

/**
 * Download HLS stream via ffmpeg, optionally muxing subtitle.
 * @param {string} m3u8Url
 * @param {string} outputPath - full .mp4 path
 * @param {object} headers
 * @param {string|null} subtitlePath
 * @param {function(string)} onLog
 * @returns {Promise<string>}
 */
function downloadHlsWithFfmpeg(m3u8Url, outputPath, headers = {}, subtitlePath = null, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const headerParts = [];
    if (headers.referer) headerParts.push(`Referer: ${headers.referer}`);
    if (headers.origin) headerParts.push(`Origin: ${headers.origin}`);
    headerParts.push(`User-Agent: ${headers.userAgent || UA}`);
    const headerStr = headerParts.join('\r\n');

    const args = ['-y', '-headers', headerStr, '-i', m3u8Url];

    if (subtitlePath && fs.existsSync(subtitlePath)) {
      args.push('-i', subtitlePath);
    }

    args.push('-c:v', 'copy', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');

    if (subtitlePath && fs.existsSync(subtitlePath)) {
      args.push('-c:s', 'mov_text', '-metadata:s:s:0', 'language=ind', '-metadata:s:s:0', 'title=Indonesia');
    }

    args.push('-movflags', '+faststart', '-timeout', '30000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', outputPath);

    onLog(`[ffmpeg] Starting download...`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastLine = '';
    let duration = 0;

    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        lastLine = line;
        const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durMatch) {
          duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
        }
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch && duration > 0) {
          const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          const pct = Math.min(99, Math.round((current / duration) * 100));
          const sizeMatch = line.match(/size=\s*([\d]+\w*)/);
          const speedMatch = line.match(/speed=([\d.]+x)/);
          onLog(`[download] ${pct}% | size=${sizeMatch?.[1] || '?'} | speed=${speedMatch?.[1] || '?'}`);
        }
      }
    });

    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${lastLine.slice(0, 200)}`));
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
        return reject(new Error('ffmpeg selesai tapi file output kosong'));
      }
      onLog(`[ffmpeg] Download complete!`);
      resolve(outputPath);
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}. Pastikan ffmpeg ter-install.`));
    });

    // Timeout 30 min
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('ffmpeg timeout (30 menit)'));
    }, 30 * 60 * 1000);
  });
}

// ─── MAIN DOWNLOAD ORCHESTRATOR ──────────────────────────────────────────────

/**
 * Full download pipeline: scrape embed URL → Playwright intercept → ffmpeg download.
 *
 * @param {string} filmUrl - full IDLIX page URL (e.g. https://pafisangirjujuan.org/some-film-2026/)
 * @param {string} outputPath - destination file path (without extension)
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<string>} actual output file path (.mp4)
 */
async function downloadFromIdlix(filmUrl, outputPath, onLog = null) {
  const logFn = onLog || (() => {});

  // Step 1: Scrape halaman film untuk dapat embed URL
  logFn('[info] Mengambil halaman film...');
  const detail = await getDetail(filmUrl);

  if (!detail.embedUrl) {
    throw new Error(`Tidak ditemukan embed player di halaman: ${filmUrl}\nHalaman mungkin belum punya video atau format berbeda.`);
  }

  logFn(`[info] Embed player: ${detail.embedUrl.slice(0, 80)}`);

  // Step 2: Intercept .m3u8 via Playwright
  logFn('[info] Launching browser untuk intercept HLS stream...');
  const { m3u8Url, headers, subtitleUrls } = await interceptM3u8(detail.embedUrl, logFn);

  // Step 3: Get subtitle
  logFn('[info] Mencari subtitle Indonesia...');
  const subPath = await getIndonesianSubtitle(
    subtitleUrls || [],
    detail.title,
    `${outputPath}_sub`,
    logFn
  );

  // Step 4: Download via ffmpeg
  logFn('[info] Memulai download via ffmpeg...');
  const mp4Path = `${outputPath}.mp4`;
  const result = await downloadHlsWithFfmpeg(m3u8Url, mp4Path, headers, subPath, logFn);

  // Cleanup subtitle temp
  if (subPath && fs.existsSync(subPath)) {
    try { fs.unlinkSync(subPath); } catch (_) {}
  }

  return result;
}

module.exports = {
  search,
  getDetail,
  getSeriesEpisodes,
  downloadFromIdlix,
  interceptM3u8,
  checkFfmpeg,
};
