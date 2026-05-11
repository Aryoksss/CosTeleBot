/**
 * Smart intent detector untuk pesan chat bebas.
 * 2 layer fallback:
 *   Layer 1 (instant, offline): regex trigger word — zero-cost
 *   Layer 2 (opsional, LLM): Groq API Llama-3.3 70B — ~220ms, 14.4k req/hari gratis
 *
 * Konfigurasi env:
 *   GROQ_API_KEY=gsk_xxx            # kalau diisi, aktifkan LLM layer
 *   GROQ_MODEL=llama-3.3-70b-versatile  (optional, default ini)
 *
 * Output:
 *   {
 *     intent: 'search' | 'other',
 *     query: string | null,
 *     preferredSource: 'cosplay' | 'r34' | 'pinterest' | 'all' | null,
 *     via: 'regex' | 'llm' | 'none'  // asal klasifikasi, untuk telemetri
 *   }
 */

const axios = require('axios');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
};

// ─── LAYER 1: REGEX ──────────────────────────────────────────────────────────

// Trigger word → extract group 1 = query
const TRIGGERS = [
  /^(?:bot\s+)?(?:tolong\s+)?(?:cari(?:in|kan)?|nyari|carikan)\s+(.+)/i,
  /^(?:saya\s+)?(?:pengen|mau|ingin)\s+(?:liat|lihat|cari|nyari|nemu|nonton|download|tonton)\s+(?:cosplay\s+|video\s+|pin\s+|pinterest\s+|anime\s+|film\s+)?(.+)/i,
  /^(?:saya\s+)?(?:mau|pengen|ingin)\s+(?:nonton|download|tonton)\s+(.+)/i,
  /^(?:nonton|tonton|download)\s+(?:anime\s+)?(.+)/i,
  /^(?:search(?:\s+for)?|looking\s+for|find(?:\s+me)?|show\s+me)\s+(.+)/i,
  /^(?:i(?:\s+am|\'m)?)\s+looking\s+(?:for\s+)?(.+)/i,
  /^(?:can\s+you\s+(?:find|search)\s+(?:me\s+)?)(.+)/i,
];

// Kata kunci eksplisit untuk preferredSource di query
const SOURCE_HINTS = {
  cosplay: /\b(cosplay(?:tele)?|album|photoshoot)\b/i,
  r34: /\b(r34|rule\s*34|rule34(?:video)?)\b/i,
  pinterest: /\b(pin(?:terest)?|pinboard)\b/i,
  jav: /\b(jav(?:tiful)?|japanese\s+adult|jav\s*video)\b/i,
  ero: /\b(erothots?|ero\s*thots?|onlyfans?\s*leaks?)\b/i,
  anime: /\b(anime|otakudesu|oploverz|streaming\s*anime|sub\s*indo|nonton\s*anime)\b/i,
  film: /\b(film|movie|series|serial|drakor|drama\s*korea|netflix|bioskop|idlix|lk21|rebahin|nonton\s*film|nonton\s*drakor|nonton\s*movie)\b/i,
};

function detectSourceHint(text) {
  for (const [src, re] of Object.entries(SOURCE_HINTS)) {
    if (re.test(text)) return src;
  }
  return null;
}

function stripSourceHint(query) {
  for (const re of Object.values(SOURCE_HINTS)) {
    query = query.replace(re, '').trim();
  }
  // Bersihkan filler words sisa (bahasa Indonesia + English)
  query = query.replace(/\b(saya|aku|gue|gw|kamu|dong|deh|dulu|bang|bro|gaes|guys|please|pls|yang|ini|itu|mau|ingin|pengen|tolong|bot|nonton|tonton|download)\b/gi, '').trim();
  // Collapse multiple spaces
  return query.replace(/\s{2,}/g, ' ').trim();
}

function detectIntentRegex(text) {
  const trimmed = text.trim();

  for (const re of TRIGGERS) {
    const m = trimmed.match(re);
    if (m && m[1] && m[1].trim().length >= 2) {
      let query = m[1].trim();
      const preferredSource = detectSourceHint(trimmed);
      query = stripSourceHint(query);

      // Guard: query terlalu pendek/panjang setelah filter
      if (query.length < 2 || query.length > 150) continue;

      return {
        intent: 'search',
        query,
        preferredSource: preferredSource || 'all',
        via: 'regex',
      };
    }
  }

  return { intent: 'other', query: null, preferredSource: null, via: 'none' };
}

// ─── LAYER 2: LLM (Groq) ─────────────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are an intent classifier for a media scraper bot.
The bot supports these scraping sources:
- "cosplay": Cosplaytele (cosplay photo albums, image-heavy)
- "r34": Rule34Video (adult video content)
- "pinterest": Pinterest (image/video mix)
- "jav": Javtiful (Japanese adult videos, JAV codes like MIDE-XXX, SSNI-XXX)
- "ero": EroThots (OnlyFans leaks, adult webcam/amateur videos)
- "anime": Anime streaming (Otakudesu + Oploverz, sub Indo, episode download)
- "film": Film & Series (IDLIX via VidSrc, movie/drakor/series download)
- "all": search all sources at once

Classify user message into intent. Return ONLY a JSON object, no prose, no markdown.
Schema:
{ "intent": "search" | "other", "query": "<extracted search query>" | null, "preferred_source": "cosplay" | "r34" | "pinterest" | "jav" | "ero" | "anime" | "film" | "all" | null }

Rules:
- If user wants to find/search something visual/media → intent="search"
- Extract core query (character name, topic, tag) without filler words like "tolong", "bot", "saya", "i want", "dong"
- Default preferred_source to "all" if not specified
- If user mentions "r34" or "rule34" → preferred_source="r34"
- If user mentions "pinterest" or "pin" → preferred_source="pinterest"
- If user mentions "cosplay" as source context → preferred_source="cosplay"
- If user mentions "jav", "javtiful", or JAV code format (e.g., MIDE-232, SSNI-001) → preferred_source="jav"
- If user mentions "erothots", "onlyfans leak", or adult amateur content → preferred_source="ero"
- If user mentions "anime", "nonton", "streaming", "sub indo", "episode", or anime titles → preferred_source="anime"
- If user mentions "film", "movie", "series", "drakor", "drama korea", "netflix", "bioskop", "idlix", "lk21" → preferred_source="film"
- Non-search messages (greetings, questions unrelated to media, help requests) → intent="other"
- Keep query in original language, don't translate`;

// Circuit breaker: kalau LLM error berturut-turut, disable sementara
let llmDisabledUntil = 0;
const LLM_DISABLE_DURATION = 10 * 60 * 1000; // 10 menit
let llmErrorStreak = 0;
const LLM_ERROR_STREAK_THRESHOLD = 3;

// In-memory cache untuk dedupe message yang sama (TTL 1 jam)
const llmCache = new Map(); // key=text.toLowerCase(), value={result, expiresAt}
const LLM_CACHE_TTL = 60 * 60 * 1000;

function cacheGet(text) {
  const key = text.toLowerCase().trim();
  const entry = llmCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { llmCache.delete(key); return null; }
  return entry.result;
}
function cacheSet(text, result) {
  const key = text.toLowerCase().trim();
  llmCache.set(key, { result, expiresAt: Date.now() + LLM_CACHE_TTL });
  // Size cap
  if (llmCache.size > 500) {
    const oldestKey = llmCache.keys().next().value;
    llmCache.delete(oldestKey);
  }
}

async function detectIntentLLM(text) {
  if (!process.env.GROQ_API_KEY) return null;
  if (Date.now() < llmDisabledUntil) return null;

  const cached = cacheGet(text);
  if (cached) return { ...cached, via: 'llm-cache' };

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  try {
    const t0 = Date.now();
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 500) }, // cap input
      ],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const content = res.data.choices[0].message.content;
    const parsed = JSON.parse(content);

    // Validasi schema
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid shape');
    const intent = parsed.intent === 'search' ? 'search' : 'other';
    const query = intent === 'search' && typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 150) : null;
    const validSources = ['cosplay', 'r34', 'pinterest', 'jav', 'ero', 'anime', 'film', 'all'];
    const preferredSource = validSources.includes(parsed.preferred_source) ? parsed.preferred_source : null;

    const result = {
      intent,
      query: query && query.length >= 2 ? query : null,
      preferredSource,
      via: 'llm',
    };

    // Kalau hasil non-actionable (search tapi query null), anggap 'other'
    if (result.intent === 'search' && !result.query) {
      result.intent = 'other';
    }

    llmErrorStreak = 0;
    cacheSet(text, { intent: result.intent, query: result.query, preferredSource: result.preferredSource });
    log.info(`[Intent-LLM] "${text.slice(0, 60)}" → ${result.intent}${result.query ? ` "${result.query}" src=${result.preferredSource}` : ''} (${Date.now() - t0}ms)`);
    return result;
  } catch (e) {
    llmErrorStreak++;
    const status = e.response?.status;
    log.warn(`[Intent-LLM] error (streak=${llmErrorStreak}/${LLM_ERROR_STREAK_THRESHOLD}): HTTP ${status || '?'} ${e.message}`);
    if (llmErrorStreak >= LLM_ERROR_STREAK_THRESHOLD) {
      llmDisabledUntil = Date.now() + LLM_DISABLE_DURATION;
      llmErrorStreak = 0;
      log.warn(`[Intent-LLM] circuit breaker tripped, disable LLM selama 10 menit`);
    }
    return null;
  }
}

// ─── API PUBLIK ──────────────────────────────────────────────────────────────

/**
 * Detect intent dari chat text bebas.
 * Strategy:
 *   1. Cek regex trigger dulu (instant, deterministik)
 *   2. Kalau regex miss DAN GROQ_API_KEY ada, coba LLM
 *   3. Kalau LLM miss / error, return hasil regex apa adanya
 */
async function detectIntent(text) {
  if (!text || typeof text !== 'string') return { intent: 'other', query: null, preferredSource: null, via: 'none' };

  // Skip untuk text yang terlalu panjang (kemungkinan paste URL / nonsense)
  if (text.length > 300) return { intent: 'other', query: null, preferredSource: null, via: 'none' };

  const regexResult = detectIntentRegex(text);
  if (regexResult.intent === 'search') return regexResult;

  // Fallback LLM kalau enabled
  const llmResult = await detectIntentLLM(text);
  if (llmResult && llmResult.intent === 'search') return llmResult;

  return regexResult; // 'other'
}

module.exports = { detectIntent };
