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
 * Resolve a host URL to a direct download link.
 * @param {string} host - 'BUZZ', 'GD', 'AKIRA', 'FILEDON'
 * @param {string} url - the host URL
 * @returns {{directUrl: string|null, method: string}}
 */
async function resolve(host, url) {
  const h = (host || '').toUpperCase();

  switch (h) {
    case 'BUZZ':
      const directUrl = await resolveBuzzheavier(url);
      return { directUrl, method: 'buzzheavier-hx-redirect' };

    case 'GD':
    case 'AKIRA':
    case 'FILEDON':
      // Not yet implemented — return null so caller can skip or use Gofile fallback
      return { directUrl: null, method: `${h.toLowerCase()}-not-implemented` };

    default:
      return { directUrl: null, method: 'unknown-host' };
  }
}

module.exports = { resolve, resolveBuzzheavier };
