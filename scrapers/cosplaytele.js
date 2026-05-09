const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://cosplaytele.com';

const CATEGORIES = {
  home: '/',
  cosplay_ero: '/category/cosplay-ero/',
  nude: '/category/nude/',
  video: '/category/video-cosplayy/',
  best: '/best-cosplayer/'
};

const httpClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  },
});

async function scrapeListing(page = 1, category = 'home', query = null) {
  try {
    let url = '';
    if (query) {
      url = `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`;
    } else {
      const catPath = CATEGORIES[category] || '/';
      url = page > 1 ? `${BASE_URL}${catPath}page/${page}/` : `${BASE_URL}${catPath}`;
    }

    const { data: html } = await httpClient.get(url);
    const $ = cheerio.load(html);
    const postsMap = new Map();

    $('.post-title a, h5 a, .image-cover a, article a').each((i, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim() || $(el).attr('title') || '';
      const thumb = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
      
      // Filter link as a post if it's pointing to a valid post link
      if (href && href.startsWith('https://cosplaytele.com/') && 
          !href.includes('/category/') && 
          !href.includes('/page/') && 
          !href.includes('/author/') && 
          !href.includes('?s=')) {
        
        let p = postsMap.get(href) || { url: href, title: '', thumb: '' };
        if (title.length > 5 && !p.title) p.title = title;
        if (thumb && !p.thumb) p.thumb = thumb;
        
        postsMap.set(href, p);
      }
    });

    const posts = Array.from(postsMap.values()).filter(p => p.title);
    return posts;
  } catch (err) {
    console.error(`cosplaytele scrapeListing error: ${err.message}`);
    return [];
  }
}

async function scrapePostDetail(postUrl) {
  try {
    const { data: html } = await httpClient.get(postUrl);
    const $ = cheerio.load(html);

    const links = {
      gofile: null,
      sorafolder: null,
      telegram: null,
      terabox: null,
      mediafire: null,
      password: null
    };

    $('a[href]').each((i, el) => {
      const h = $(el).attr('href');
      if (!h) return;

      if (h.includes('gofile.io')) links.gofile = h;
      else if (h.includes('sorafolder.com')) links.sorafolder = h;
      else if (h.includes('t.me')) links.telegram = h;
      else if (h.includes('terabox.com')) links.terabox = h;
      else if (h.includes('mediafire.com')) links.mediafire = h;
    });

    // Scrape password arsip dari body post. Cosplaytele biasa taruh di <strong>/<b>/text dengan
    // format "Password: xxx" atau "Pass: xxx" atau "PW: xxx" (case-insensitive).
    const bodyText = $('.entry-content, article, .post-content, body').text();
    const pwPatterns = [
      /password\s*[:=]\s*([A-Za-z0-9_\-.@#$!]+)/i,
      /\bpass\s*[:=]\s*([A-Za-z0-9_\-.@#$!]+)/i,
      /\bpw\s*[:=]\s*([A-Za-z0-9_\-.@#$!]+)/i,
      /unzip\s*password\s*[:=]\s*([A-Za-z0-9_\-.@#$!]+)/i,
    ];
    for (const re of pwPatterns) {
      const m = bodyText.match(re);
      if (m && m[1] && m[1].length >= 3 && m[1].length <= 64) {
        links.password = m[1].trim();
        break;
      }
    }

    return links;
  } catch (err) {
    console.error(`cosplaytele scrapeDetail error: ${err.message}`);
    return null;
  }
}

module.exports = {
  scrapeListing,
  scrapePostDetail,
  CATEGORIES
};
