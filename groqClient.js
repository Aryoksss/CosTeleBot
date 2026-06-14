'use strict';

/**
 * Groq API client terpusat — fondasi semua fitur LLM/AI bot (intent, STT, vision).
 *
 * Menyatukan: konfigurasi key/model, timeout (AbortController), retry 429/5xx dengan
 * backoff, dan circuit breaker GLOBAL (kalau Groq error beruntun, semua call di-skip
 * sementara supaya tidak nge-spam API yang lagi down + hemat latency).
 *
 * Env:
 *   GROQ_API_KEY        wajib untuk aktif (kalau kosong, isEnabled()=false)
 *   GROQ_MODEL          model chat default (default: llama-3.3-70b-versatile)
 *
 * Catatan: butuh Node 18+ (global fetch + AbortController).
 */

const BASE = 'https://api.groq.com/openai/v1';

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
};

// ─── Circuit breaker global (melindungi SEMUA call Groq) ──────────────────────
let disabledUntil = 0;
let errorStreak = 0;
const DISABLE_MS = 10 * 60 * 1000;   // skip Groq 10 menit setelah error beruntun
const STREAK_THRESHOLD = 4;

function hasKey() {
  return !!process.env.GROQ_API_KEY;
}

/** True kalau key ada DAN circuit breaker tidak sedang aktif. */
function isEnabled() {
  return hasKey() && Date.now() >= disabledUntil;
}

function _markOk() {
  errorStreak = 0;
}

function _markFail(reason) {
  errorStreak++;
  if (errorStreak >= STREAK_THRESHOLD) {
    disabledUntil = Date.now() + DISABLE_MS;
    errorStreak = 0;
    log.warn(`[Groq] circuit breaker tripped — disable ${DISABLE_MS / 60000} menit (${reason})`);
  }
}

async function _fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Chat completion. Return string konten balasan. Throw kalau gagal total.
 *
 * @param {object}   p
 * @param {Array}    p.messages       array {role, content} ala OpenAI
 * @param {string}   [p.model]        override model (default GROQ_MODEL)
 * @param {number}   [p.temperature]  default 0 (deterministik)
 * @param {number}   [p.maxTokens]    default 300
 * @param {boolean}  [p.json]         true → minta response_format json_object
 * @param {number}   [p.timeoutMs]    default 12000
 * @param {number}   [p.retries]      retry untuk 429/5xx, default 2
 * @returns {Promise<string>}
 */
async function chat({ messages, model, temperature = 0, maxTokens = 300, json = false, timeoutMs = 12000, retries = 2 }) {
  if (!hasKey()) throw new Error('GROQ_API_KEY not set');

  const body = {
    model: model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await _fetchWithTimeout(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, timeoutMs);

      // Transient → retry
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Groq HTTP ${res.status}`);
        if (attempt <= retries) {
          const ra = parseInt(res.headers.get('retry-after') || '0', 10);
          await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : attempt * 1500);
          continue;
        }
        _markFail(`HTTP ${res.status}`);
        throw lastErr;
      }

      if (!res.ok) {
        _markFail(`HTTP ${res.status}`);
        throw new Error(`Groq HTTP ${res.status}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty content');
      _markOk();
      return content;
    } catch (e) {
      lastErr = e;
      // Timeout / network → retry kalau masih ada jatah
      if (attempt <= retries && (e.name === 'AbortError' || e.code === 'ECONNRESET' || /network|fetch failed/i.test(e.message))) {
        await sleep(attempt * 1500);
        continue;
      }
      _markFail(e.message);
      throw e;
    }
  }
  throw lastErr || new Error('Groq chat gagal');
}

/**
 * Chat dengan output JSON. Parse hasil ke object. Throw kalau bukan JSON valid.
 */
async function chatJSON(opts) {
  const content = await chat({ ...opts, json: true });
  return JSON.parse(content);
}

module.exports = { hasKey, isEnabled, chat, chatJSON };
