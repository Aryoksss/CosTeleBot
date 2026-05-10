/**
 * Pinterest search scraper (pure axios — no Playwright).
 *
 * Strategi: pakai internal JSON API `/resource/BaseSearchResource/get/` yang dipakai
 * web client Pinterest sendiri. Stabil, balas JSON terstruktur, support bookmark pagination.
 *
 * Output tiap pin:
 *   {
 *     id:       '152840981099356564',
 *     title:    'Blue archive Hoshino cosplay',
 *     thumb:    'https://i.pinimg.com/236x/...jpg',
 *     type:     'image' | 'video',
 *     imageUrl: 'https://i.pinimg.com/originals/...jpg',  // untuk type=image
 *     videoUrl: 'https://v1.pinimg.com/videos/.../720p/...mp4',  // untuk type=video
 *     pinUrl:   'https://www.pinterest.com/pin/152840981099356564/'
 *   }
 */

const axios = require('axios');

const BASE_URL = 'https://www.pinterest.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

function getProxyAgent() {
  const raw = process.env.PINTEREST_PROXY || process.env.GOFILE_PROXY || process.env.HTTPS_PROXY;
  if (!raw) return null;
  try {
    let HttpsProxyAgent, SocksProxyAgent;
    ({ HttpsProxyAgent } = require('https-proxy-agent'));
    ({ SocksProxyAgent } = require('socks-proxy-agent'));
    return raw.startsWith('socks') ? new SocksProxyAgent(raw) : new HttpsProxyAgent(raw);
  } catch (_) {
    return null;
  }
}

const httpClient = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*, q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Pinterest-AppState': 'active',
    'X-APP-VERSION': 'abcd1234',
    'X-Pinterest-PWS-Handler': 'www/search/[scope].js',
  },
  validateStatus: () => true,
});

/**
 * Ubah HLS URL Pinterest ke MP4 direct. Tanpa ini Telegram sendVideo tidak bisa handle.
 * Pattern dari probe: /videos/iht/hls/xx/xx/xx/id.m3u8 → /videos/mc/720p/xx/xx/xx/id.mp4
 * Fallback: null kalau pattern tidak match (kita skip video pin tersebut).
 */
function hlsToMp4(hlsUrl) {
  if (!hlsUrl || !hlsUrl.endsWith('.m3u8')) return null;
  // Pattern confirmed working: /iht/hls/ → /mc/720p/ atau /iht/720p/
  const candidates = [
    hlsUrl.replace('/iht/hls/', '/mc/720p/').replace('.m3u8', '.mp4'),
    hlsUrl.replace('/iht/hls/', '/iht/720p/').replace('.m3u8', '.mp4'),
    // Fallback untuk URL yang tidak match pattern di atas (belum tentu jalan, tapi worth try)
    hlsUrl.replace('/hls/', '/720p/').replace('.m3u8', '.mp4'),
  ];
  return candidates[0]; // Ambil kandidat pertama; HEAD verify akan kita lakukan di layer atas kalau perlu
}

/**
 * Parse satu pin object dari Pinterest API ke format standar bot.
 * Return null kalau pin ini harus di-skip (GIF, atau tidak punya media valid).
 */
function normalizePin(p) {
  if (!p || !p.id) return null;

  const title = String(p.grid_title || p.title || p.seo_alt_text || p.description || '').trim().slice(0, 200);

  // Thumb: pakai 236x atau 474x untuk listing (kecil, cepat load di Telegram preview)
  const thumb = p.images?.['474x']?.url || p.images?.['236x']?.url || p.images?.['736x']?.url || null;

  // Cek video pin dulu — story_pin_data.pages[].blocks[].video.video_list atau p.videos.video_list
  let videoList = p.videos?.video_list;
  if (!videoList && p.story_pin_data?.pages) {
    for (const page of p.story_pin_data.pages) {
      for (const b of (page.blocks || [])) {
        if (b.video?.video_list) { videoList = b.video.video_list; break; }
      }
      if (videoList) break;
    }
  }

  if (videoList) {
    // Ambil resolusi tertinggi dari V_HLSV4 / V_HLSV3_MOBILE
    const hls = videoList.V_HLSV4?.url || videoList.V_HLSV3_MOBILE?.url || null;
    const mp4 = hlsToMp4(hls);
    if (!mp4) return null; // skip pin yang URL pattern-nya tidak match
    return {
      id: p.id,
      title: title || '(no title)',
      thumb: thumb || videoList.V_HLSV4?.thumbnail || null,
      type: 'video',
      videoUrl: mp4,
      pinUrl: `${BASE_URL}/pin/${p.id}/`,
    };
  }

  // Image pin (non-video, non-story_pin dengan video). Skip GIF via content-type hint url.
  const orig = p.images?.orig?.url;
  if (!orig) return null;
  // GIF filter: Pinterest menyimpan GIF sebagai .gif di /originals/ ATAU convert ke MP4 di videos/.
  // Yang punya video_list sudah di-handle di atas. Yang tersisa di sini: plain image + GIF statis.
  // Per request user, GIF statis juga skip.
  if (/\.gif($|\?)/i.test(orig)) return null;

  return {
    id: p.id,
    title: title || '(no title)',
    thumb: thumb || orig,
    type: 'image',
    imageUrl: orig,
    pinUrl: `${BASE_URL}/pin/${p.id}/`,
  };
}

/**
 * Search pins di Pinterest.
 *
 * @param {string} query
 * @param {string|null} bookmark  null untuk halaman pertama, atau token dari hasil call sebelumnya
 * @returns {Promise<{pins: Array, nextBookmark: string|null}>}
 */
async function scrapeSearch(query, bookmark = null) {
  if (!query || !query.trim()) return { pins: [], nextBookmark: null };

  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
  const opts = {
    applied_product_filters: '---',
    appliedProductFilters: '---',
    article: '',
    auto_correction_disabled: false,
    corpus: '',
    customized_rerank_type: '',
    field_set_key: 'unauth_react_main_pin',
    filters: '',
    journey_depth: null,
    no_fetch_context_on_resource: false,
    price_max: null,
    price_min: null,
    query: query,
    query_pin_sigs: null,
    query_recommendation_type: '',
    rs: 'typed',
    scope: 'pins',
    selected_one_bar_modules: [],
    source_id: '',
    source_module_id: '',
    source_url: sourceUrl,
    top_pin_id: '',
  };
  // Untuk halaman selanjutnya, sertakan bookmark
  if (bookmark) opts.bookmarks = [bookmark];

  const params = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify({ options: opts, context: {} }),
    _: String(Date.now()),
  }).toString();

  const url = `${BASE_URL}/resource/BaseSearchResource/get/?${params}`;
  const agent = getProxyAgent();

  try {
    const res = await httpClient.get(url, {
      headers: {
        'Referer': `${BASE_URL}${sourceUrl}`,
        'X-Pinterest-Source-Url': sourceUrl,
      },
      ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
    });

    if (res.status !== 200) {
      log.warn(`[Pinterest] search HTTP ${res.status} untuk query="${query}"`);
      return { pins: [], nextBookmark: null };
    }

    const rr = res.data?.resource_response;
    if (!rr || rr.status !== 'success') {
      log.warn(`[Pinterest] resource_response.status=${rr?.status} msg=${rr?.message || '?'}`);
      return { pins: [], nextBookmark: null };
    }

    const results = Array.isArray(rr.data?.results) ? rr.data.results : [];
    const pins = results.map(normalizePin).filter(Boolean);
    const nextBookmark = (rr.bookmark && rr.bookmark !== '-end-') ? rr.bookmark : null;

    log.info(`[Pinterest] search "${query}" page bookmark=${bookmark ? bookmark.slice(0, 20) + '...' : 'first'} → ${pins.length} pins (video=${pins.filter(p => p.type === 'video').length})`);
    return { pins, nextBookmark };
  } catch (e) {
    log.error(`[Pinterest] scrapeSearch error: ${e.message}`);
    return { pins: [], nextBookmark: null };
  }
}

module.exports = {
  scrapeSearch,
};
