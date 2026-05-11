'use strict';
/**
 * IDLIX / Film scraper — search film & series via TMDB, stream via VidSrc/IDLIX embed.
 *
 * Flow:
 *   1. Search: TMDB API (gratis, no auth) → dapat TMDB ID + metadata
 *   2. Stream: Playwright intercept HLS .m3u8 + subtitle (.vtt/.srt) dari embed player
 *   3. Download: ffmpeg -i <m3u8_url> -i <subtitle> -c copy -c:s mov_text output.mp4
 *   4. Fallback subtitle: OpenSubtitles API (bahasa Indonesia)
 *
 * Requires on VPS:
 *   apt install ffmpeg
 *   npx playwright install chromium  (atau: npx playwright install-deps && npx playwright install)
 */

const axios = require('axios');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

const TMDB_BASE = 'https://api.themoviedb.org/3';
// TMDB API key — wajib di-set di .env
const TMDB_KEY = () => process.env.TMDB_API_KEY;
const VIDSRC_BASE = 'https://vidsrc.to/embed';

// IDLIX WordPress site (no Cloudflare)
const IDLIX_BASE = () => process.env.IDLIX_BASE_URL || 'https://159.65.50.100';

// OpenSubtitles API (free tier: 100 req/day tanpa API key, 1000/day dengan key)
const OPENSUB_BASE = 'https://api.opensubtitles.com/api/v1';
const OPENSUB_KEY = () => process.env.OPENSUBTITLES_API_KEY || '';

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
 * Intercept HLS .m3u8 URL + subtitle tracks from an embed player page using Playwright.
 * Navigates through nested iframes to reach the actual video player.
 *
 * Chain: vidsrc.to → vsembed.ru → cloudnestra.com/vidplay/filemoon → .m3u8
 *
 * @param {string} type - 'movie' or 'tv'
 * @param {number} tmdbId
 * @param {number|null} season
 * @param {number|null} episode
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<{m3u8Url: string, headers: object, subtitleUrls: string[]}>}
 */
async function interceptM3u8(type, tmdbId, season, episode, onLog = () => {}) {
  // Build list of embed URLs to try
  const idlixBase = IDLIX_BASE();
  const urls = [
    type === 'movie'
      ? `${VIDSRC_BASE}/movie/${tmdbId}`
      : `${VIDSRC_BASE}/tv/${tmdbId}/${season}/${episode}`,
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

        // Global network interception — catches ALL requests including from nested iframes
        const m3u8Urls = [];
        const subtitleUrls = [];
        const capturedHeaders = {};

        // Use route to intercept ALL requests across all frames
        await page.route('**/*', async (route) => {
          const url = route.request().url();

          if (url.includes('.m3u8')) {
            m3u8Urls.push(url);
            const hdrs = route.request().headers();
            capturedHeaders.referer = hdrs.referer || hdrs['Referer'] || '';
            capturedHeaders.origin = hdrs.origin || hdrs['Origin'] || '';
            capturedHeaders.userAgent = hdrs['user-agent'] || UA;
          }

          if (url.includes('.vtt') || url.includes('.srt') || url.includes('subtitle') || url.includes('caption') || url.includes('track')) {
            if (!subtitleUrls.includes(url)) subtitleUrls.push(url);
          }

          // Continue the request normally
          await route.continue().catch(() => {});
        });

        // Navigate to the embed page
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (navErr) {
          onLog(`[warn] Navigation failed: ${navErr.message.slice(0, 80)}`);
          await context.close();
          continue;
        }

        // Wait for page + iframes to load
        await page.waitForTimeout(3000);

        // Try clicking play buttons in all frames (main + nested iframes)
        const clickPlayInAllFrames = async () => {
          const allFrames = page.frames();
          for (const frame of allFrames) {
            try {
              const playSelectors = [
                '.play-button', '#play-button', '[class*="play"]',
                'button[aria-label="Play"]', '.jw-icon-display', '.vjs-big-play-button',
                '.plyr__control--overlaid', '[data-plyr="play"]',
                '.vjs-play-control', '#player', '.player-play',
              ];
              for (const sel of playSelectors) {
                const btn = await frame.$(sel);
                if (btn) {
                  await btn.click().catch(() => {});
                  break;
                }
              }
            } catch (_) {}
          }
        };

        await clickPlayInAllFrames();

        // Wait for .m3u8 request to appear (up to 30 seconds)
        // The nested iframe chain can take time to resolve
        const deadline = Date.now() + 30000;
        while (m3u8Urls.length === 0 && Date.now() < deadline) {
          await page.waitForTimeout(2000);
          await clickPlayInAllFrames();
        }

        if (m3u8Urls.length > 0) {
          // Prefer master playlist
          let bestUrl = m3u8Urls.find(u => u.includes('master')) ||
                        m3u8Urls.find(u => !u.includes('/seg') && !u.includes('/chunk')) ||
                        m3u8Urls[0];

          onLog(`[info] Found .m3u8: ${bestUrl.slice(0, 100)}...`);
          if (subtitleUrls.length > 0) {
            onLog(`[info] Found ${subtitleUrls.length} subtitle track(s) from player`);
          }
          await context.close();
          return {
            m3u8Url: bestUrl,
            headers: {
              referer: capturedHeaders.referer || pageUrl,
              origin: capturedHeaders.origin || new URL(pageUrl).origin,
              userAgent: capturedHeaders.userAgent || UA,
            },
            subtitleUrls,
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
 * Fetch Indonesian subtitle from OpenSubtitles API.
 * Free tier: 100 downloads/day tanpa API key, 1000/day dengan key.
 *
 * @param {number} tmdbId
 * @param {string} type - 'movie' or 'tv'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {function(string)} onLog
 * @returns {Promise<string|null>} - URL to download subtitle file, or null
 */
async function fetchOpenSubtitlesId(tmdbId, type, season, episode, onLog = () => {}) {
  try {
    const params = {
      tmdb_id: tmdbId,
      languages: 'id',  // Indonesian
      order_by: 'download_count',
      order_direction: 'desc',
    };
    if (type === 'tv' && season && episode) {
      params.season_number = season;
      params.episode_number = episode;
    }

    const headers = {
      'User-Agent': 'CosTeleBot v1.0',
      'Accept': 'application/json',
    };
    const apiKey = OPENSUB_KEY();
    if (apiKey) headers['Api-Key'] = apiKey;

    const { data } = await http.get(`${OPENSUB_BASE}/subtitles`, { params, headers, timeout: 10000 });

    if (!data.data || data.data.length === 0) {
      onLog('[subtitle] Tidak ada subtitle Indonesia di OpenSubtitles');
      return null;
    }

    // Pick the best one (highest download count, prefer .srt)
    const best = data.data[0];
    const fileId = best.attributes?.files?.[0]?.file_id;
    if (!fileId) {
      onLog('[subtitle] Subtitle ditemukan tapi tidak ada file_id');
      return null;
    }

    onLog(`[subtitle] Found: "${best.attributes?.release || 'unknown'}" (${best.attributes?.download_count || 0} downloads)`);

    // Request download link
    const dlHeaders = { ...headers, 'Content-Type': 'application/json' };
    const { data: dlData } = await http.post(`${OPENSUB_BASE}/download`, { file_id: fileId }, { headers: dlHeaders, timeout: 10000 });

    if (dlData.link) {
      return dlData.link;
    }
    onLog('[subtitle] Gagal dapat download link dari OpenSubtitles');
    return null;
  } catch (err) {
    onLog(`[subtitle] OpenSubtitles error: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Download subtitle file to local path.
 * Supports .vtt and .srt URLs. Converts .vtt to .srt if needed (ffmpeg handles both).
 *
 * @param {string} url - subtitle download URL
 * @param {string} destPath - local file path to save (without extension, will add .srt)
 * @param {function(string)} onLog
 * @returns {Promise<string|null>} - local path to subtitle file, or null on failure
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
    const sizeMB = (Buffer.byteLength(data) / 1024).toFixed(1);
    onLog(`[subtitle] Downloaded: ${sizeMB} KB → ${path.basename(subPath)}`);
    return subPath;
  } catch (err) {
    onLog(`[subtitle] Download gagal: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Try to get Indonesian subtitle from multiple sources:
 * 1. Intercepted subtitle URLs from embed player (prefer Indonesian/id)
 * 2. OpenSubtitles API fallback
 *
 * @param {string[]} interceptedUrls - subtitle URLs captured from player
 * @param {number} tmdbId
 * @param {string} type - 'movie' or 'tv'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {string} destPath - base path for saving subtitle (without extension)
 * @param {function(string)} onLog
 * @returns {Promise<string|null>} - local subtitle file path, or null
 */
async function getIndonesianSubtitle(interceptedUrls, tmdbId, type, season, episode, destPath, onLog = () => {}) {
  // Strategy 1: Check intercepted URLs for Indonesian subtitle
  // Many players include language in URL: /id.vtt, /ind.srt, ?lang=id, etc.
  const idPatterns = [/[/.]id[./]/, /[/.]ind[./]/, /indonesi/i, /lang=id/i, /bahasa/i];

  // First try: find explicitly Indonesian subtitle from intercepted
  for (const url of interceptedUrls) {
    const isIndo = idPatterns.some(p => p.test(url));
    if (isIndo) {
      onLog(`[subtitle] Found Indonesian subtitle from player: ${url.slice(0, 80)}`);
      const result = await downloadSubtitle(url, destPath, onLog);
      if (result) return result;
    }
  }

  // Second try: if only 1 subtitle intercepted (likely the active one from player, often Indonesian on IDLIX)
  if (interceptedUrls.length === 1) {
    onLog(`[subtitle] Trying single intercepted subtitle (mungkin Indonesia): ${interceptedUrls[0].slice(0, 80)}`);
    const result = await downloadSubtitle(interceptedUrls[0], destPath, onLog);
    if (result) return result;
  }

  // Strategy 2: Fallback to OpenSubtitles API
  onLog('[subtitle] Mencari subtitle Indonesia di OpenSubtitles...');
  const osUrl = await fetchOpenSubtitlesId(tmdbId, type, season, episode, onLog);
  if (osUrl) {
    const result = await downloadSubtitle(osUrl, destPath, onLog);
    if (result) return result;
  }

  // Strategy 3: If multiple intercepted URLs, try them all (might be multi-language)
  if (interceptedUrls.length > 1) {
    onLog(`[subtitle] Trying ${interceptedUrls.length} intercepted subtitle URLs...`);
    for (const url of interceptedUrls) {
      const result = await downloadSubtitle(url, destPath, onLog);
      if (result) return result;
    }
  }

  onLog('[subtitle] Tidak ada subtitle Indonesia yang tersedia');
  return null;
}

/**
 * Download HLS stream via ffmpeg, optionally muxing subtitle.
 * @param {string} m3u8Url - HLS master/variant playlist URL
 * @param {string} outputPath - destination .mp4 file path (full path with extension)
 * @param {object} headers - HTTP headers (referer, origin, userAgent)
 * @param {string|null} subtitlePath - local .srt/.vtt file to mux, or null
 * @param {function(string)} onLog - progress callback
 * @returns {Promise<string>} actual output file path
 */
function downloadHlsWithFfmpeg(m3u8Url, outputPath, headers = {}, subtitlePath = null, onLog = () => {}) {
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
    ];

    // Add subtitle input if available
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      args.push('-i', subtitlePath);
    }

    args.push(
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
    );

    // Mux subtitle as soft-sub (mov_text for mp4 container)
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      args.push('-c:s', 'mov_text');
      args.push('-metadata:s:s:0', 'language=ind');
      args.push('-metadata:s:s:0', 'title=Indonesia');
    }

    args.push(
      '-movflags', '+faststart',
      '-timeout', '30000000',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      outputPath,
    );

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

  // Step 1: Intercept .m3u8 + subtitle via Playwright
  logFn('[info] Launching browser untuk intercept HLS stream...');
  const { m3u8Url, headers, subtitleUrls } = await interceptM3u8(type, parseInt(tmdbId), season ? parseInt(season) : null, episode ? parseInt(episode) : null, logFn);

  // Step 2: Get Indonesian subtitle (from player intercept or OpenSubtitles fallback)
  logFn('[info] Mencari subtitle Indonesia...');
  const subPath = await getIndonesianSubtitle(
    subtitleUrls || [],
    parseInt(tmdbId),
    type,
    season ? parseInt(season) : null,
    episode ? parseInt(episode) : null,
    `${outputPath}_sub`,
    logFn
  );

  // Step 3: Download via ffmpeg (with subtitle muxed if available)
  logFn('[info] Stream ditemukan! Memulai download via ffmpeg...');
  const mp4Path = `${outputPath}.mp4`;
  const result = await downloadHlsWithFfmpeg(m3u8Url, mp4Path, headers, subPath, logFn);

  // Cleanup subtitle temp file
  if (subPath && fs.existsSync(subPath)) {
    try { fs.unlinkSync(subPath); } catch (_) {}
  }

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
