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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 20000, headers: { 'User-Agent': UA } });

/**
 * Search series by title (client-side filter karena API tidak punya search param).
 * Fetch halaman 1-5 (50 series terbaru) + filter lokal.
 * Untuk full search, bisa fetch semua 65 halaman tapi terlalu berat — cukup 5 halaman.
 * @returns {Array<{id, title, slug, poster, status, genres, totalEpisodes, source}>}
 */
async function search(query, maxPages = 10) {
  const q = query.toLowerCase().trim().replace(/[.\-:]/g, ' ').replace(/\s+/g, ' ');
  const qWords = q.split(' ').filter(w => w.length >= 2);
  const results = [];

  // Fetch pages in parallel batches
  const pages = Array.from({ length: maxPages }, (_, i) => i + 1);
  const responses = await Promise.allSettled(
    pages.map(p => http.get(`${API_BASE()}/series?page=${p}`))
  );

  let totalPages = maxPages;
  for (const res of responses) {
    if (res.status !== 'fulfilled') continue;
    const { data } = res.value;
    if (!data || !data.data) continue;
    if (data.meta?.lastPage) totalPages = data.meta.lastPage;
    for (const s of data.data) {
      const titleLow = (s.title + ' ' + (s.japaneseTitle || '')).toLowerCase().replace(/[.\-:]/g, ' ');
      // Match if ALL query words appear in title (fuzzy word match)
      const allMatch = qWords.every(w => titleLow.includes(w));
      if (allMatch) {
        results.push({
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
        });
      }
    }
  }

  // Deep search: if no results in first batch and there are more pages, fetch remaining
  if (results.length === 0 && totalPages > maxPages) {
    const deepPages = Array.from({ length: Math.min(totalPages - maxPages, 55) }, (_, i) => maxPages + i + 1);
    // Fetch in batches of 10 to avoid overwhelming
    for (let batch = 0; batch < deepPages.length; batch += 10) {
      const chunk = deepPages.slice(batch, batch + 10);
      const deepRes = await Promise.allSettled(
        chunk.map(p => http.get(`${API_BASE()}/series?page=${p}`))
      );
      for (const res of deepRes) {
        if (res.status !== 'fulfilled') continue;
        const { data } = res.value;
        if (!data || !data.data) continue;
        for (const s of data.data) {
          const titleLow = (s.title + ' ' + (s.japaneseTitle || '')).toLowerCase().replace(/[.\-:]/g, ' ');
          const allMatch = qWords.every(w => titleLow.includes(w));
          if (allMatch) {
            results.push({
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
            });
          }
        }
      }
      if (results.length > 0) break; // Found something, stop deep search
    }
  }

  return results.slice(0, 15);
}

/**
 * Get series detail.
 */
async function getSeriesDetail(slug) {
  const { data } = await http.get(`${API_BASE()}/series/${slug}`);
  return data?.data || null;
}

/**
 * Get all episodes for a series (paginated, fetch all pages).
 * @returns {Array<episode>} sorted by episodeNumber ascending
 */
async function getEpisodes(slug, maxPages = 10) {
  const allEps = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await http.get(`${API_BASE()}/series/${slug}/episodes?page=${page}`);
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

module.exports = { search, getSeriesDetail, getEpisodes, pickBestLink, getAllLinks };
