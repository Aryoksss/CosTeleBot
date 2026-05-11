'use strict';
/**
 * IDLIX / Film scraper — search film & series via TMDB, stream via VidSrc/IDLIX embed.
 *
 * Flow:
 *   1. Search: TMDB API (gratis, no auth) → dapat TMDB ID + metadata
 *   2. Stream: Playwright intercept HLS .m3u8 dari embed player
 *   3. Download: ffmpeg -i <m3u8_url> -c copy output.mp4
 *
 * Requires on VPS:
 *   apt install ffmpeg
 *   npx playwright install chromium  (atau: npx playwright install-deps && npx playwright install)
 */

const axios = require('axios');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');

chromium.use(StealthPlugin());

const TMDB_BASE = 'https://api.themoviedb.org/3';
// Public TMDB API key (read-only, rate-limited but free)
const TMDB_KEY = () => process.env.TMDB_API_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const VIDSRC_BASE = 'https://vidsrc.to/embed';

// IDLIX WordPress site (no Cloudflare)
const IDLIX_BASE = () => process.env.IDLIX_BASE_URL || 'https://159.65.50.100';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA } });

/**
 * Search film/series via TMDB.
 * @param {string} query
 * @param {'movie'|'tv'|'multi'} type
 * @returns {Array<{id, title, type, year, overview, poster, rating, seasons}>}
 */
async function search(query, type = 'multi') {
  const { data } = await http.get(`${TMDB_BASE}/search/${type}`, {
    params: { api_key: TMDB_KEY(), query, language: 'id-ID', include_adult: false },
  });

  return (data.results || []).slice(0, 10).map(r => ({
    id: r.id,
    title: r.title || r.name || 'Unknown',
    type: r.media_type || type,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    overview: (r.overview || '').slice(0, 200),
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
    rating: r.vote_average ? r.vote_average.toFixed(1) : null,
    seasons: r.number_of_seasons || null,
    source: 'idlix',
  }));
}

/**
 * Get TV series details: seasons + episode count.
 */
async function getSeriesDetail(tmdbId) {
  const { data } = await http.get(`${TMDB_BASE}/tv/${tmdbId}`, {
    params: { api_key: TMDB_KEY(), language: 'id-ID' },
  });
  return {
    id: data.id,
    title: data.name,
    overview: (data.overview || '').slice(0, 300),
    poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
    rating: data.vote_average?.toFixed(1),
    seasons: (data.seasons || [])
      .filter(s => s.season_number > 0) // skip specials (season 0)
      .map(s => ({
        number: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        year: (s.air_date || '').slice(0, 4),
      })),
  };
}

/**
 * Get episode list for a season.
 */
async function getEpisodes(tmdbId, season) {
  const { data } = await http.get(`${TMDB_BASE}/tv/${tmdbId}/season/${season}`, {
    params: { api_key: TMDB_KEY(), language: 'id-ID' },
  });
  return (data.episodes || []).map(ep => ({
    number: ep.episode_number,
    name: ep.name,
    overview: (ep.overview || '').slice(0, 150),
    airDate: ep.air_date,
    runtime: ep.runtime,
  }));
}

/**
 * Build VidSrc embed URL.
 */
function buildVidSrcUrl(type, tmdbId, season = null, episode = null) {
  if (type === 'movie') {
    return `${VIDSRC_BASE}/movie/${tmdbId}`;
  }
  return `${VIDSRC_BASE}/tv/${tmdbId}/${season}/${episode}`;
}

/**
 * Check if ffmpeg is available.
 */
function checkFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
  return result.status === 0;
}

/**
 * Intercept HLS .m3u8 URL from an embed player page using Playwright.
 * Navigates through iframes and waits for network requests containing .m3u8.
 *
 * Strategy:
 *   1. Try IDLIX WordPress page first (has embed player directly)
 *   2. Fallback to VidSrc embed URLs
 *
 * @param {string} type - 'movie' or 'tv'
 * @param {number} tmdbId
 * @param {number|null} season
 * @param {number|null} episode
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<{m3u8Url: string, headers: object}>} - HLS master playlist URL + headers for ffmpeg
 */
async function interceptM3u8(type, tmdbId, season, episode, onLog = () => {}) {
  // Build list of URLs to try
  const idlixBase = IDLIX_BASE();
  const urls = [
    // VidSrc embed (primary — most reliable for HLS interception)
    type === 'movie'
      ? `${VIDSRC_BASE}/movie/${tmdbId}`
      : `${VIDSRC_BASE}/tv/${tmdbId}/${season}/${episode}`,
    // VidSrc alternatives
    type === 'movie'
      ? `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`
      : `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`,
    type === 'movie'
      ? `https://player.autoembed.cc/embed/movie/${tmdbId}`
      : `https://player.autoembed.cc/embed/tv/${tmdbId}/${season}/${episode}`,
    type === 'movie'
      ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`
      : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
  ];

  // If IDLIX base is configured and not default IP, add it as first option
  if (idlixBase && !idlixBase.includes('159.65.50.100')) {
    urls.unshift(
      type === 'movie'
        ? `${idlixBase}/embed/movie/${tmdbId}`
        : `${idlixBase}/embed/tv/${tmdbId}/${season}/${episode}`
    );
  }

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

    for (const pageUrl of urls) {
      onLog(`[info] Trying embed: ${pageUrl.slice(0, 80)}...`);

      let context;
      try {
        context = await browser.newContext({
          userAgent: UA,
          ignoreHTTPSErrors: true,
          bypassCSP: true,
        });

        const page = await context.newPage();

        // Collect .m3u8 URLs from network requests
        const m3u8Urls = [];
        const capturedHeaders = {};

        page.on('request', (req) => {
          const url = req.url();
          if (url.includes('.m3u8')) {
            m3u8Urls.push(url);
            // Capture request headers for ffmpeg (referer, origin, etc.)
            const hdrs = req.headers();
            capturedHeaders.referer = hdrs.referer || hdrs.Referer || '';
            capturedHeaders.origin = hdrs.origin || hdrs.Origin || '';
            capturedHeaders.userAgent = hdrs['user-agent'] || UA;
          }
        });

        // Also intercept responses for .m3u8 in case request event misses some
        page.on('response', (res) => {
          const url = res.url();
          if (url.includes('.m3u8') && !m3u8Urls.includes(url)) {
            m3u8Urls.push(url);
          }
        });

        // Navigate to the embed page
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (navErr) {
          onLog(`[warn] Navigation failed: ${navErr.message.slice(0, 80)}`);
          await context.close();
          continue;
        }

        // Wait a bit for initial JS to load
        await page.waitForTimeout(2000);

        // Try to find and click play button (common patterns)
        try {
          // Common play button selectors across embed players
          const playSelectors = [
            '.play-button', '#play-button', '[class*="play"]',
            'button[aria-label="Play"]', '.jw-icon-display', '.vjs-big-play-button',
            '.plyr__control--overlaid', '[data-plyr="play"]',
          ];
          for (const sel of playSelectors) {
            const btn = await page.$(sel);
            if (btn) {
              await btn.click().catch(() => {});
              onLog(`[info] Clicked play button: ${sel}`);
              break;
            }
          }
        } catch (_) {}

        // Also try clicking inside iframes
        const frames = page.frames();
        for (const frame of frames) {
          if (frame === page.mainFrame()) continue;
          try {
            const playSelectors = [
              '.play-button', '#play-button', '[class*="play"]',
              'button[aria-label="Play"]', '.jw-icon-display', '.vjs-big-play-button',
              '.plyr__control--overlaid', '[data-plyr="play"]',
            ];
            for (const sel of playSelectors) {
              const btn = await frame.$(sel);
              if (btn) {
                await btn.click().catch(() => {});
                onLog(`[info] Clicked play in iframe: ${sel}`);
                break;
              }
            }
          } catch (_) {}
        }

        // Wait for .m3u8 request to appear (up to 25 seconds)
        const deadline = Date.now() + 25000;
        while (m3u8Urls.length === 0 && Date.now() < deadline) {
          await page.waitForTimeout(1000);

          // Re-check frames that may have loaded later
          const laterFrames = page.frames();
          for (const frame of laterFrames) {
            if (frame === page.mainFrame()) continue;
            try {
              // Try clicking play in newly loaded frames
              const btn = await frame.$('.play-button, .jw-icon-display, .vjs-big-play-button, [class*="play"]');
              if (btn) await btn.click().catch(() => {});
            } catch (_) {}
          }
        }

        if (m3u8Urls.length > 0) {
          // Prefer master playlist (usually shorter URL or contains "master" / "playlist")
          let bestUrl = m3u8Urls.find(u => u.includes('master')) ||
                        m3u8Urls.find(u => !u.includes('/seg') && !u.includes('/chunk')) ||
                        m3u8Urls[0];

          onLog(`[info] Found .m3u8: ${bestUrl.slice(0, 100)}...`);
          await context.close();
          return {
            m3u8Url: bestUrl,
            headers: {
              referer: capturedHeaders.referer || pageUrl,
              origin: capturedHeaders.origin || new URL(pageUrl).origin,
              userAgent: capturedHeaders.userAgent || UA,
            },
          };
        }

        onLog(`[warn] No .m3u8 found on ${pageUrl.slice(0, 60)}`);
        await context.close();
      } catch (err) {
        onLog(`[warn] Error on ${pageUrl.slice(0, 60)}: ${err.message.slice(0, 80)}`);
        if (context) await context.close().catch(() => {});
      }
    }

    throw new Error('Tidak dapat menemukan stream HLS (.m3u8) dari semua embed provider. Film mungkin belum tersedia.');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Download HLS stream via ffmpeg.
 * @param {string} m3u8Url - HLS master/variant playlist URL
 * @param {string} outputPath - destination .mp4 file path (full path with extension)
 * @param {object} headers - HTTP headers (referer, origin, userAgent)
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<string>} actual output file path
 */
function downloadHlsWithFfmpeg(m3u8Url, outputPath, headers = {}, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    // Build ffmpeg headers string
    const headerParts = [];
    if (headers.referer) headerParts.push(`Referer: ${headers.referer}`);
    if (headers.origin) headerParts.push(`Origin: ${headers.origin}`);
    headerParts.push(`User-Agent: ${headers.userAgent || UA}`);
    const headerStr = headerParts.join('\r\n');

    const args = [
      '-y',
      '-headers', headerStr,
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-timeout', '30000000',  // 30s timeout for network operations
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      outputPath,
    ];

    onLog(`[ffmpeg] Starting download...`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastLine = '';
    let duration = 0;

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n').filter(l => l.trim());

      for (const line of lines) {
        lastLine = line;

        // Parse duration from stream info: Duration: 01:32:45.67
        const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durMatch) {
          duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
        }

        // Parse progress: time=00:05:23.45
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch && duration > 0) {
          const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          const pct = Math.min(99, Math.round((current / duration) * 100));
          // Parse speed and size
          const sizeMatch = line.match(/size=\s*([\d]+\w*)/);
          const speedMatch = line.match(/speed=([\d.]+x)/);
          const size = sizeMatch ? sizeMatch[1] : '?';
          const speed = speedMatch ? speedMatch[1] : '?';
          onLog(`[download] ${pct}% | size=${size} | speed=${speed}`);
        }
      }
    });

    proc.stdout.on('data', () => {}); // drain stdout

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exit ${code}: ${lastLine.slice(0, 200)}`));
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
        return reject(new Error('ffmpeg selesai tapi file output kosong/tidak ada'));
      }
      onLog(`[ffmpeg] Download complete!`);
      resolve(outputPath);
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}. Pastikan ffmpeg ter-install.`));
    });

    // Timeout: 30 minutes max
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('ffmpeg timeout (30 menit) — file mungkin terlalu besar atau koneksi lambat'));
    }, 30 * 60 * 1000);
  });
}

/**
 * Download video via Playwright HLS interception + ffmpeg.
 * Main entry point replacing the old yt-dlp approach.
 *
 * @param {string} url - VidSrc embed URL (used to extract TMDB ID + type)
 * @param {string} outputPath - destination file path (without extension)
 * @param {string} quality - '1080', '720', '480', '360'
 * @param {function(string)} onLog - callback for progress lines
 * @returns {Promise<string>} actual output file path (.mp4)
 */
async function downloadWithPlaywright(url, outputPath, quality = '720', onLog = null) {
  const logFn = onLog || (() => {});

  // Extract TMDB ID from VidSrc URL
  const tmdbMatch = url.match(/\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/);
  if (!tmdbMatch) throw new Error('Cannot parse TMDB ID from VidSrc URL');

  const [, type, tmdbId, season, episode] = tmdbMatch;

  // Step 1: Intercept .m3u8 via Playwright
  logFn('[info] Launching browser untuk intercept HLS stream...');
  const { m3u8Url, headers } = await interceptM3u8(type, parseInt(tmdbId), season ? parseInt(season) : null, episode ? parseInt(episode) : null, logFn);

  // Step 2: Download via ffmpeg
  logFn('[info] Stream ditemukan! Memulai download via ffmpeg...');
  const mp4Path = `${outputPath}.mp4`;
  const result = await downloadHlsWithFfmpeg(m3u8Url, mp4Path, headers, logFn);

  return result;
}

module.exports = {
  search,
  getSeriesDetail,
  getEpisodes,
  buildVidSrcUrl,
  downloadWithPlaywright,
  checkFfmpeg,
  interceptM3u8,
};
