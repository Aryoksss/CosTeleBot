'use strict';
/**
 * Oploverz scraper — uses open backend API at backapi.oploverz.ac.
 * No auth required. JSON responses.
 * 
 * API endpoints:
 *   GET /api/series                         — paginated list (10/page, sorted newest)
 *   GET /api/series/<slug>                  — series detail
 *   GET /api/series/<slug>/episodes?page=N  — episodes with download links + stream URLs
 *
 * Download hosts: BUZZ (buzzheavier) preferred, then Gofile if present.
 * Archive password: "oploverz.me"
 */

const axios = require('axios');

const API_BASE = () => process.env.OPLOVERZ_API_BASE || 'https://backapi.oploverz.ac/api';

const UA = require('../utils/ua').UA;

const http = axios.create({ timeout: 20000, headers: { 'User-Agent': UA } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * GET API dengan retry ringan untuk network error / 5xx. Return body JSON, atau throw.
 */
async function apiGet(path, params = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await http.get(`${API_BASE()}${path}`, { params, validateStatus: () => true });
      if (res.status >= 200 && res.status < 300) return res.data;
      if (res.status >= 500 && attempt < 3) { await sleep(attempt * 800); continue; }
      throw new Error(`Oploverz API HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) { await sleep(attempt * 800); continue; }
    }
  }
  throw lastErr || new Error('Oploverz API tidak responsif');
}

/** Normalisasi objek series API → bentuk standar bot. */
function normalizeSeries(s) {
  return {
    id: s.id,
    title: s.title,
    slug: s.slug,
    poster: s.poster,
    status: s.status,
    genres: (s.genres || []).map(g => g.name),
    totalEpisodes: s.totalEpisodes || 0,
    duration: s.duration,
    score: s.score,
    source: 'oploverz',
  };
}

/**
 * Search series by title (client-side filter karena API tidak punya search param).
 * Fetch halaman 1-5 (50 series terbaru) + filter lokal.
 * Untuk full search, bisa fetch semua 65 halaman tapi terlalu berat — cukup 5 halaman.
 * @returns {Array<{id, title, slug, poster, status, genres, totalEpisodes, source}>}
 */
/**
 * Search series via parameter server-side `?q=` (akurat + cukup 1 request).
 * Jauh lebih cepat & ringan daripada scan semua halaman + filter di client.
 * @param {string} query
 * @param {number} page  halaman hasil (default 1)
 * @returns {Array<series>}
 */
async function search(query, page = 1) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  try {
    const data = await apiGet('/series', { q, page });
    const list = (data && data.data) || [];
    return list.slice(0, 15).map(normalizeSeries);
  } catch (e) {
    console.error(`\x1b[31m[ERROR]\x1b[0m [Oploverz] search "${q}" gagal: ${e.message}`);
    return [];
  }
}

/**
 * Get series detail.
 */
async function getSeriesDetail(slug) {
  const data = await apiGet(`/series/${slug}`);
  return data?.data || null;
}

/**
 * Get all episodes for a series (paginated, fetch all pages).
 * @returns {Array<episode>} sorted by episodeNumber ascending
 */
async function getEpisodes(slug, maxPages = 10) {
  const allEps = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await apiGet(`/series/${slug}/episodes`, { page });
    if (!data || !data.data || data.data.length === 0) break;
    allEps.push(...data.data);
    if (page >= (data.meta?.lastPage || 1)) break;
  }
  // Sort ascending by episode number
  allEps.sort((a, b) => parseInt(a.episodeNumber) - parseInt(b.episodeNumber));
  return allEps;
}

/**
 * Pick best download link from episode data.
 * Priority: BUZZ > Gofile (if any) > FILEDON > AKIRA > GD
 * Prefer mp4 720p or 1080p.
 * @param {object} episode - episode object from API
 * @param {string} preferQuality - '480p' | '720p' | '1080p'
 * @param {string} preferFormat - 'mp4' | 'mkv' | 'x265'
 * @returns {{host, url, quality, format}|null}
 */
function pickBestLink(episode, preferQuality = '720p', preferFormat = 'mp4') {
  if (!episode || !episode.downloadUrl) return null;

  const hostPriority = ['BUZZ', 'FILEDON', 'AKIRA', 'GD'];
  const qualityPriority = [preferQuality, '720p', '1080p', '480p', '360p'];

  // Find matching format
  let formatBlock = episode.downloadUrl.find(f => f.format.toLowerCase().includes(preferFormat));
  if (!formatBlock) formatBlock = episode.downloadUrl[0]; // fallback first format
  if (!formatBlock || !formatBlock.resolutions) return null;

  // Find matching quality
  let resolution = null;
  for (const q of qualityPriority) {
    resolution = formatBlock.resolutions.find(r => r.quality === q);
    if (resolution) break;
  }
  if (!resolution) resolution = formatBlock.resolutions[0];
  if (!resolution || !resolution.download_links) return null;

  // Find best host
  for (const hostName of hostPriority) {
    const link = resolution.download_links.find(l => l.host === hostName);
    if (link) {
      return {
        host: link.host,
        url: link.url,
        quality: resolution.quality,
        format: formatBlock.format,
      };
    }
  }

  // Fallback: first available
  const first = resolution.download_links[0];
  return first ? { host: first.host, url: first.url, quality: resolution.quality, format: formatBlock.format } : null;
}

/**
 * Get all available quality options for an episode.
 * @returns {Array<{format, quality, host, url}>}
 */
function getAllLinks(episode) {
  if (!episode || !episode.downloadUrl) return [];
  const links = [];
  const hostPriority = ['BUZZ', 'FILEDON', 'AKIRA', 'GD'];

  for (const fmt of episode.downloadUrl) {
    for (const res of (fmt.resolutions || [])) {
      // Pick best host for this quality
      let picked = null;
      for (const h of hostPriority) {
        const l = (res.download_links || []).find(x => x.host === h);
        if (l) { picked = l; break; }
      }
      if (!picked && res.download_links?.length) picked = res.download_links[0];
      if (picked) {
        links.push({
          format: fmt.format,
          quality: res.quality,
          host: picked.host,
          url: picked.url,
        });
      }
    }
  }
  return links;
}

/**
 * Get latest series (page 1 = newest).
 * @returns Normalized array with source='oploverz'
 */
async function getLatest(page = 1) {
  const data = await apiGet('/series', { page });
  if (!data || !data.data) return [];
  return data.data.map(normalizeSeries);
}

/**
 * Get ongoing anime only.
 */
async function getOngoing(page = 1) {
  const latest = await getLatest(page);
  return latest.filter(s => s.status === 'Ongoing');
}

module.exports = { search, getSeriesDetail, getEpisodes, pickBestLink, getAllLinks, getLatest, getOngoing };
