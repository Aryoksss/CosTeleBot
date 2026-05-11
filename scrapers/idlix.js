'use strict';
/**
 * IDLIX / Film scraper — search film & series via TMDB, stream via VidSrc.
 *
 * Flow:
 *   1. Search: TMDB API (gratis, no auth) → dapat TMDB ID + metadata
 *   2. Stream: VidSrc embed (https://vidsrc.to/embed/{type}/{tmdb_id}/...)
 *   3. Download: yt-dlp extract HLS + download ke .mp4
 *
 * Requires on VPS:
 *   pip install yt-dlp   (atau: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp)
 *   apt install ffmpeg
 */

const axios = require('axios');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TMDB_BASE = 'https://api.themoviedb.org/3';
// Public TMDB API key (read-only, rate-limited but free)
const TMDB_KEY = () => process.env.TMDB_API_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const VIDSRC_BASE = 'https://vidsrc.to/embed';

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
 * Check if yt-dlp is available.
 */
function checkYtDlp() {
  const result = spawnSync('yt-dlp', ['--version'], { timeout: 5000 });
  return result.status === 0;
}

/**
 * Check if ffmpeg is available.
 */
function checkFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
  return result.status === 0;
}

/**
 * Download video via yt-dlp.
 * @param {string} url - VidSrc embed URL
 * @param {string} outputPath - destination file path (without extension, yt-dlp adds it)
 * @param {string} quality - '720', '480', '360' (height)
 * @param {function(string)} onLog - callback for progress lines
 * @returns {Promise<string>} actual output file path
 */
async function downloadWithYtDlp(url, outputPath, quality = '720', onLog = null) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '--output', `${outputPath}.%(ext)s`,
      '--format', `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--progress',
      '--newline',
      '--user-agent', UA,
      '--add-header', `Referer:${VIDSRC_BASE}`,
      '--concurrent-fragments', '4',
      '--retries', '3',
      '--fragment-retries', '3',
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastLine = '';
    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        lastLine = line;
        if (onLog) onLog(line);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line && onLog) onLog(`[stderr] ${line}`);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exit code ${code}. Last output: ${lastLine.slice(0, 200)}`));
      }
      // Find the actual output file
      const mp4Path = `${outputPath}.mp4`;
      const mkvPath = `${outputPath}.mkv`;
      if (fs.existsSync(mp4Path)) return resolve(mp4Path);
      if (fs.existsSync(mkvPath)) return resolve(mkvPath);
      // Fallback: find any file with the base name
      const dir = path.dirname(outputPath);
      const base = path.basename(outputPath);
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
      if (files.length > 0) return resolve(path.join(dir, files[0]));
      reject(new Error('yt-dlp selesai tapi file output tidak ditemukan'));
    });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp spawn error: ${err.message}. Pastikan yt-dlp ter-install di VPS.`));
    });
  });
}

module.exports = {
  search,
  getSeriesDetail,
  getEpisodes,
  buildVidSrcUrl,
  downloadWithYtDlp,
  checkYtDlp,
  checkFfmpeg,
};
