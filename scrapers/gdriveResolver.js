'use strict';
/**
 * Google Drive direct downloader for public files.
 * Handles the "virus scan warning" page for large files (>100 MB) by parsing the confirm token.
 *
 * Pattern:
 *   1. GET https://drive.google.com/uc?export=download&id=FILE_ID
 *   2. Small files → direct stream
 *   3. Large files → HTML page with <form action="..."> containing confirm token
 *      Parse form action + confirm token, POST to get actual download URL
 *
 * Limits:
 *   - Public files only (no auth)
 *   - Daily quota ~750 GB per file (shared) → rarely hit for anime
 *   - If file hits quota: "Sorry, you can't view or download this file at this time"
 */

const axios = require('axios');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Extract file ID from various GDrive URL formats.
 */
function extractFileId(url) {
  // Format 1: drive.google.com/uc?export=download&id=FILE_ID
  let m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Format 2: drive.google.com/file/d/FILE_ID/view
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Format 3: drive.google.com/open?id=FILE_ID
  m = url.match(/[?&]open\?id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

/**
 * Download from Google Drive with progress + large file virus-scan bypass.
 * @param {string} gdriveUrl
 * @param {string} destPath
 * @param {function(pct, speed, eta)} onProgress
 */
async function downloadGDrive(gdriveUrl, destPath, onProgress) {
  const fileId = extractFileId(gdriveUrl);
  if (!fileId) throw new Error('Cannot extract Google Drive file ID from URL');

  const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  // Attempt 1: direct request with cookie jar (manual)
  const cookieJar = [];
  let confirmUrl = null;
  let filename = null;

  const res1 = await axios.get(initialUrl, {
    maxRedirects: 5,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': UA },
    timeout: 30000,
    validateStatus: () => true,
  });

  // Save cookies
  const setCookies = res1.headers['set-cookie'] || [];
  for (const c of setCookies) {
    cookieJar.push(c.split(';')[0]);
  }

  const contentType = (res1.headers['content-type'] || '').toLowerCase();
  const contentDisp = res1.headers['content-disposition'] || '';

  // Case 1: direct file download (small file)
  if (!contentType.includes('text/html')) {
    // This IS the file content — save it
    filename = parseFilename(contentDisp) || `gdrive_${fileId}`;
    fs.writeFileSync(destPath, res1.data);
    const size = res1.data.length;
    if (onProgress) onProgress(100, size, 0);
    return { name: filename, size, path: destPath };
  }

  // Case 2: HTML page (large file virus scan warning OR quota error)
  const html = res1.data.toString('utf8');

  // Check for quota error
  if (/quota|can't\s+view\s+or\s+download|sorry/i.test(html)) {
    throw new Error('Google Drive quota exceeded for this file. Try again in 24 hours or use another host.');
  }

  // Parse confirm token from form action
  const formMatch = html.match(/action="([^"]+)"[^>]*id="download-form"/) ||
                    html.match(/<form[^>]+action="([^"]+)"/);
  if (!formMatch) {
    throw new Error('Google Drive: cannot find download form (file may require auth or not shared publicly)');
  }

  // Parse hidden fields
  const action = formMatch[1].replace(/&amp;/g, '&');
  const hiddenInputs = {};
  const inputRegex = /<input\s+type="hidden"\s+name="([^"]+)"\s+value="([^"]*)"/g;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(html)) !== null) {
    hiddenInputs[inputMatch[1]] = inputMatch[2];
  }

  // Build query string from hidden inputs
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(hiddenInputs)) params.append(k, v);

  confirmUrl = action.includes('?') ? `${action}&${params.toString()}` : `${action}?${params.toString()}`;

  // Now stream the actual download with cookies
  const res2 = await axios.get(confirmUrl, {
    responseType: 'stream',
    maxRedirects: 10,
    headers: {
      'User-Agent': UA,
      'Cookie': cookieJar.join('; '),
    },
    timeout: 60000,
  });

  filename = parseFilename(res2.headers['content-disposition']) || `gdrive_${fileId}`;
  const totalSize = parseInt(res2.headers['content-length'] || '0', 10);

  let downloaded = 0;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);

    res2.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (onProgress) {
        // Pass (done, total) — konsumen bisa pakai renderProgressBar langsung.
        // Kalau totalSize=0 (GDrive kadang nggak kirim content-length), total=0 dan
        // renderer akan display bar indeterminate.
        onProgress(downloaded, totalSize);
      }
    });

    res2.data.on('error', (err) => {
      try { writeStream.close(); } catch (_) {}
      reject(err);
    });

    writeStream.on('error', (err) => {
      try { res2.data.destroy(); } catch (_) {}
      reject(err);
    });

    writeStream.on('finish', () => {
      resolve({ name: filename, size: downloaded, path: destPath });
    });

    res2.data.pipe(writeStream);
  });
}

function parseFilename(contentDisp) {
  if (!contentDisp) return null;
  // Try RFC 5987 first (UTF-8)
  let m = contentDisp.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) return decodeURIComponent(m[1].replace(/"/g, ''));
  // Fallback to filename="..."
  m = contentDisp.match(/filename="([^"]+)"/);
  if (m) return m[1];
  m = contentDisp.match(/filename=([^;]+)/);
  if (m) return m[1].trim();
  return null;
}

module.exports = { downloadGDrive, extractFileId };
