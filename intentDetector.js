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

const groq = require('./groqClient');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
};

// ─── LAYER 1: REGEX ──────────────────────────────────────────────────────────

// Trigger word → extract group 1 = query
const TRIGGERS = [
  /^(?:bot\s+)?(?:tolong\s+)?(?:cari(?:in|kan)?|nyari|carikan|search|find)\s+(.+)/i,
  /^(?:saya\s+)?(?:pengen|mau|ingin|pgn|kepengen)\s+(?:liat|lihat|cari|nyari|nemu|nonton|download|tonton|donlot|unduh)\s+(?:cosplay\s+|video\s+|pin\s+|pinterest\s+|anime\s+)?(.+)/i,
  /^(?:saya\s+)?(?:mau|pengen|ingin|pgn)\s+(?:nonton|download|tonton|donlot|unduh)\s+(.+)/i,
  /^(?:nonton|tonton|download|donlot|unduh|streaming)\s+(?:anime\s+)?(.+)/i,
  /^(?:ada\s+)(.+?)\s+(?:ga|gak|nggak|gk|engga)\??$/i,            // "ada nami cosplay ga?"
  /^(?:kasih|kasi|berikan|beri)\s+(?:dong\s+|aku\s+|saya\s+)?(.+)/i, // "kasih nami cosplay"
  /^(?:search(?:\s+for)?|looking\s+for|find(?:\s+me)?|show\s+me)\s+(.+)/i,
  /^(?:i(?:\s+am|\'m)?)\s+looking\s+(?:for\s+)?(.+)/i,
  /^(?:can\s+you\s+(?:find|search)\s+(?:me\s+)?)(.+)/i,
];

// Kode JAV: 2-6 huruf + (opsional pemisah) + 2-5 digit. Mis. "mide232", "ssni 001", "ABP-123".
const JAV_CODE_RE = /^([a-z]{2,6})[\s-]?(\d{2,5})$/i;
function normalizeJavCode(text) {
  const m = String(text || '').trim().match(JAV_CODE_RE);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

// Kata kunci eksplisit untuk preferredSource di query
const SOURCE_HINTS = {
  cosplay: /\b(cosplay(?:tele)?|album|photoshoot)\b/i,
  r34: /\b(r34|rule\s*34|rule34(?:video)?)\b/i,
  pinterest: /\b(pin(?:terest)?|pinboard)\b/i,
  jav: /\b(jav(?:tiful)?|japanese\s+adult|jav\s*video)\b/i,
  ero: /\b(erothots?|ero\s*thots?|onlyfans?\s*leaks?)\b/i,
  xnxx: /\b(xnxx|x\s*nxx)\b/i,
  anime: /\b(anime|otakudesu|oploverz|streaming\s*anime|sub\s*indo|nonton\s*anime)\b/i,
};

function detectSourceHint(text) {
  for (const [src, re] of Object.entries(SOURCE_HINTS)) {
    if (re.test(text)) return src;
  }
  return null;
}

// Sumber di awal pesan (tanpa kata kerja), mis. "pinterest gintama", "r34 tifa", "xnxx cosplay".
const LEADING_SOURCE = [
  [/^(?:cosplaytele|cosplay)\b[\s:,-]*/i, 'cosplay'],
  [/^(?:rule\s*34|rule34(?:video)?|r34)\b[\s:,-]*/i, 'r34'],
  [/^(?:pin(?:terest)?)\b[\s:,-]*/i, 'pinterest'],
  [/^(?:jav(?:tiful)?)\b[\s:,-]*/i, 'jav'],
  [/^(?:erothots?|ero)\b[\s:,-]*/i, 'ero'],
  [/^(?:xnxx)\b[\s:,-]*/i, 'xnxx'],
  [/^(?:anime|otakudesu|oploverz|kusonime)\b[\s:,-]*/i, 'anime'],
];

function stripSourceHint(query) {
  for (const re of Object.values(SOURCE_HINTS)) {
    query = query.replace(re, '').trim();
  }
  // Bersihkan filler words + preposisi sisa (bahasa Indonesia + English)
  query = query.replace(/\b(saya|aku|gue|gw|kamu|dong|deh|dulu|bang|bro|gaes|guys|please|pls|yang|ini|itu|mau|ingin|pengen|tolong|bot|nonton|tonton|download|di|ke|dari|pada|nya|sih|nih|ya|gih)\b/gi, '').trim();
  // Collapse multiple spaces
  return query.replace(/\s{2,}/g, ' ').trim();
}

function detectIntentRegex(text) {
  const trimmed = text.trim();

  // 0) Kode JAV mentah (mis. "MIDE-232") → langsung search ke Javtiful.
  const jav = normalizeJavCode(trimmed);
  if (jav) {
    return { intent: 'search', query: jav, preferredSource: 'jav', via: 'regex' };
  }

  for (const re of TRIGGERS) {
    const m = trimmed.match(re);
    if (m && m[1] && m[1].trim().length >= 2) {
      let query = m[1].trim();
      let preferredSource = detectSourceHint(trimmed);

      // Kalau query berisi kode JAV (mis. "cari mide 232"), normalisasi + paksa source jav.
      const javInQuery = normalizeJavCode(query);
      if (javInQuery) {
        return { intent: 'search', query: javInQuery, preferredSource: 'jav', via: 'regex' };
      }

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

  // Fallback: pola "<sumber> <query>" tanpa kata kerja (mis. "pinterest gintama", "r34 tifa").
  for (const [re, src] of LEADING_SOURCE) {
    if (re.test(trimmed)) {
      let rest = trimmed.replace(re, '').trim();
      const jav2 = normalizeJavCode(rest);
      if (jav2) return { intent: 'search', query: jav2, preferredSource: 'jav', via: 'regex' };
      rest = stripSourceHint(rest);
      const words = rest.split(/\s+/).filter(Boolean);
      // Gate anti-false-positive: query pendek (1-5 kata) & bukan kalimat tanya.
      if (rest.length >= 2 && rest.length <= 60 && words.length <= 5 && !/^(apa|gimana|kenapa|kok|bisa|gak|nggak)\b/i.test(rest)) {
        return { intent: 'search', query: rest, preferredSource: src, via: 'regex' };
      }
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
- "xnxx": XNXX (general adult video tube, all categories)
- "anime": Anime streaming (Otakudesu + Oploverz, sub Indo, episode download)
- "all": search all sources at once

Classify user message into intent. Return ONLY a JSON object, no prose, no markdown.
Schema:
{ "intent": "search" | "other", "query": "<extracted search query>" | null, "preferred_source": "cosplay" | "r34" | "pinterest" | "jav" | "ero" | "xnxx" | "anime" | "all" | null }

Rules:
- If user wants to find/search something visual/media → intent="search"
- Extract the core query (character name, topic, tag) and remove filler words like "tolong", "bot", "saya", "i want", "dong", "pengen"
- Fix obvious typos in the query, but PRESERVE proper nouns (character / cosplayer / anime titles) and their original language — do NOT translate names/titles
- Normalize JAV codes to uppercase with a dash (e.g. "mide232" or "mide 232" → "MIDE-232")
- Default preferred_source to "all" if not specified
- If user mentions "r34" or "rule34" → preferred_source="r34"
- If user mentions "pinterest" or "pin" → preferred_source="pinterest"
- If user mentions "cosplay" as source context → preferred_source="cosplay"
- If user mentions "jav", "javtiful", or JAV code format (e.g., MIDE-232, SSNI-001) → preferred_source="jav"
- If user mentions "erothots", "onlyfans leak", or adult amateur content → preferred_source="ero"
- If user mentions "xnxx" → preferred_source="xnxx"
- If user mentions "anime", "nonton", "streaming", "sub indo", "episode", or anime titles → preferred_source="anime"
- Non-search messages (greetings, questions unrelated to media, help requests) → intent="other"`;

// Circuit breaker & retry kini ditangani terpusat di groqClient.js.

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
  if (!groq.isEnabled()) return null;

  const cached = cacheGet(text);
  if (cached) return { ...cached, via: 'llm-cache' };

  try {
    const t0 = Date.now();
    const parsed = await groq.chatJSON({
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 500) }, // cap input
      ],
      temperature: 0,
      maxTokens: 150,
    });

    // Validasi schema
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid shape');
    const intent = parsed.intent === 'search' ? 'search' : 'other';
    const query = intent === 'search' && typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 150) : null;
    const validSources = ['cosplay', 'r34', 'pinterest', 'jav', 'ero', 'xnxx', 'anime', 'all'];    const preferredSource = validSources.includes(parsed.preferred_source) ? parsed.preferred_source : null;

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

    cacheSet(text, { intent: result.intent, query: result.query, preferredSource: result.preferredSource });
    log.info(`[Intent-LLM] "${text.slice(0, 60)}" → ${result.intent}${result.query ? ` "${result.query}" src=${result.preferredSource}` : ''} (${Date.now() - t0}ms)`);
    return result;
  } catch (e) {
    log.warn(`[Intent-LLM] error: ${e.message}`);
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
