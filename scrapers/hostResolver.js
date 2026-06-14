'use strict';
/**
 * Host resolver — extract direct download URLs from various file hosts.
 * Currently supports:
 *   - Buzzheavier: GET /<id>/download → Hx-Redirect header → direct fafda.to URL
 *   - Gofile: delegate to existing gofile.js
 *
 * Future: Filedon (needs CSRF dance), Akirabox, Acefile
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Resolve Buzzheavier link to direct download URL.
 * Pattern: GET https://buzzheavier.com/<id>/download
 *   → 204 response with Hx-Redirect header pointing to fafda.to CDN
 * @param {string} url - e.g. "https://buzzheavier.com/83cif3e19gtl"
 * @returns {string|null} direct download URL
 */
async function resolveBuzzheavier(url) {
  // Extract file ID from URL
  const match = url.match(/buzzheavier\.com\/([a-z0-9]+)/i);
  if (!match) return null;
  const fileId = match[1];

  try {
    const res = await axios.get(`https://buzzheavier.com/${fileId}/download`, {
      headers: {
        'User-Agent': UA,
        'Referer': `https://buzzheavier.com/${fileId}`,
        'HX-Request': 'true',
      },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      timeout: 15000,
    });

    // Check Hx-Redirect header (HTMX pattern)
    const redirect = res.headers['hx-redirect'] || res.headers['location'];
    if (redirect && redirect.includes('fafda.to')) {
      return redirect;
    }

    // Some responses might be 302 with Location
    return redirect || null;
  } catch (err) {
    // Axios throws on 3xx when maxRedirects=0, check response
    if (err.response) {
      const redirect = err.response.headers['hx-redirect'] || err.response.headers['location'];
      if (redirect) return redirect;
    }
    return null;
  }
}

/**
 * Resolve Filedon (filedon.co) → presigned Cloudflare R2 URL (direct download).
 *
 * filedon.co adalah SPA Laravel/Inertia. Halaman /embed/<slug> menanam data awal
 * di atribut `data-page` (JSON), dan props-nya berisi `url` = presigned R2 URL
 * (X-Amz-Signature, expire 1 jam) yang bisa langsung di-stream. Tanpa CSRF/cookie/ad.
 *
 * @param {string} url - https://filedon.co/view/<slug> | /embed/<slug> | /d/<slug>
 * @returns {{directUrl: string|null, filename: string|null}}
 */
async function resolveFiledon(url) {
  const m = url.match(/filedon\.co\/(?:view|embed|d|f)\/([A-Za-z0-9_-]+)/i);
  if (!m) return { directUrl: null, filename: null };
  const slug = m[1];

  const res = await axios.get(`https://filedon.co/embed/${slug}`, {
    headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: () => true,
  });
  if (res.status !== 200) return { directUrl: null, filename: null };

  const dp = String(res.data).match(/data-page="([^"]+)"/);
  if (!dp) return { directUrl: null, filename: null };

  let data;
  try {
    const json = dp[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    data = JSON.parse(json);
  } catch (_) {
    return { directUrl: null, filename: null };
  }

  const p = data.props || {};
  const directUrl = (typeof p.url === 'string' && /^https?:\/\//.test(p.url)) ? p.url : null;
  const filename = (p.files && p.files.name) || null;
  return { directUrl, filename };
}

/**
 * Resolve a host URL to a direct download link.
 * @param {string} host - 'BUZZ', 'FILEDON', 'GD', 'AKIRA'
 * @param {string} url - the host URL
 * @returns {{directUrl: string|null, method: string, filename?: string|null}}
 */
async function resolve(host, url) {
  const h = (host || '').toUpperCase();

  switch (h) {
    case 'BUZZ': {
      const directUrl = await resolveBuzzheavier(url);
      return { directUrl, method: 'buzzheavier-hx-redirect' };
    }

    case 'FILEDON': {
      const { directUrl, filename } = await resolveFiledon(url);
      return { directUrl, filename, method: 'filedon-embed-presigned' };
    }

    case 'GD':
    case 'AKIRA':
      // Belum diimplement — caller bisa skip / pakai host lain.
      return { directUrl: null, method: `${h.toLowerCase()}-not-implemented` };

    default:
      return { directUrl: null, method: 'unknown-host' };
  }
}

module.exports = { resolve, resolveBuzzheavier, resolveFiledon };
