'use strict';

/**
 * Client LLM terpusat — fondasi semua fitur AI bot (intent detection, asisten).
 *
 * Mendukung MULTI-PROVIDER (OpenAI-compatible) dengan fallback otomatis:
 *   1. Groq      (primary)  — cepat & gratis (Llama 3.3 70B)
 *   2. DeepSeek  (fallback) — dipakai kalau Groq tak ada key / circuit-breaker aktif / error
 *
 * Kalau provider pertama gagal beruntun, circuit breaker per-provider menonaktifkannya
 * sementara, dan call otomatis pindah ke provider berikutnya.
 *
 * Env:
 *   GROQ_API_KEY / GROQ_MODEL            (default model llama-3.3-70b-versatile)
 *   DEEPSEEK_API_KEY / DEEPSEEK_MODEL    (default model deepseek-v4-flash)
 *   AI_PROVIDER_ORDER                    urutan provider, default "groq,deepseek"
 *
 * Catatan: butuh Node 18+ (global fetch + AbortController).
 */

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
};

// ─── Definisi provider (OpenAI-compatible) ────────────────────────────────────
const PROVIDERS = {
  groq: {
    name: 'groq',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  deepseek: {
    name: 'deepseek',
    base: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-v4-flash',
  },
};

// Circuit breaker per-provider.
const DISABLE_MS = 10 * 60 * 1000;
const STREAK_THRESHOLD = 4;
const breakers = {}; // name -> { disabledUntil, streak }
function _bk(name) { return breakers[name] || (breakers[name] = { disabledUntil: 0, streak: 0 }); }

function _key(p) { return process.env[p.keyEnv]; }
function _model(p) { return process.env[p.modelEnv] || p.defaultModel; }

function _order() {
  const raw = process.env.AI_PROVIDER_ORDER || 'groq,deepseek';
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(n => PROVIDERS[n]);
  return names.length ? names : ['groq', 'deepseek'];
}

/** Daftar provider yang punya key (urut sesuai AI_PROVIDER_ORDER). */
function _configured() {
  return _order().map(n => PROVIDERS[n]).filter(p => p && _key(p));
}

/** True kalau minimal satu provider punya API key. */
function hasKey() {
  return _configured().length > 0;
}

/** True kalau minimal satu provider punya key DAN tidak sedang circuit-broken. */
function isEnabled() {
  const now = Date.now();
  return _configured().some(p => now >= _bk(p.name).disabledUntil);
}

function _markOk(name) { _bk(name).streak = 0; }
function _markFail(name, reason) {
  const b = _bk(name);
  b.streak++;
  if (b.streak >= STREAK_THRESHOLD) {
    b.disabledUntil = Date.now() + DISABLE_MS;
    b.streak = 0;
    log.warn(`[AI:${name}] circuit breaker tripped — disable ${DISABLE_MS / 60000} menit (${reason})`);
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

/** Satu provider: retry 429/5xx + timeout. Throw kalau gagal total. */
async function _chatOne(p, { messages, model, temperature, maxTokens, json, timeoutMs, retries }) {
  const body = {
    model: model || _model(p),
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await _fetchWithTimeout(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_key(p)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, timeoutMs);

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${p.name} HTTP ${res.status}`);
        if (attempt <= retries) {
          const ra = parseInt(res.headers.get('retry-after') || '0', 10);
          await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : attempt * 1500);
          continue;
        }
        _markFail(p.name, `HTTP ${res.status}`);
        throw lastErr;
      }
      if (!res.ok) {
        _markFail(p.name, `HTTP ${res.status}`);
        throw new Error(`${p.name} HTTP ${res.status}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty content');
      _markOk(p.name);
      return content;
    } catch (e) {
      lastErr = e;
      if (attempt <= retries && (e.name === 'AbortError' || e.code === 'ECONNRESET' || /network|fetch failed/i.test(e.message))) {
        await sleep(attempt * 1500);
        continue;
      }
      _markFail(p.name, e.message);
      throw e;
    }
  }
  throw lastErr || new Error(`${p.name} chat gagal`);
}

/**
 * Chat completion dengan fallback antar-provider. Return string konten. Throw kalau semua gagal.
 *
 * @param {object}  p
 * @param {Array}   p.messages
 * @param {string}  [p.model]
 * @param {number}  [p.temperature=0]
 * @param {number}  [p.maxTokens=300]
 * @param {boolean} [p.json=false]
 * @param {number}  [p.timeoutMs=12000]
 * @param {number}  [p.retries=2]
 * @returns {Promise<string>}
 */
async function chat({ messages, model, temperature = 0, maxTokens = 300, json = false, timeoutMs = 12000, retries = 2 }) {
  const configured = _configured();
  if (!configured.length) throw new Error('Tidak ada AI provider (set GROQ_API_KEY atau DEEPSEEK_API_KEY)');

  const now = Date.now();
  // Provider yang aktif (tidak circuit-broken) dulu; kalau semua broken, tetap coba semua.
  let pool = configured.filter(p => now >= _bk(p.name).disabledUntil);
  if (!pool.length) pool = configured;

  let lastErr = null;
  for (const p of pool) {
    try {
      const content = await _chatOne(p, { messages, model: model && p.name === pool[0].name ? model : undefined, temperature, maxTokens, json, timeoutMs, retries });
      if (p !== pool[0]) log.info(`[AI] fallback ke ${p.name} berhasil`);
      return content;
    } catch (e) {
      lastErr = e;
      log.warn(`[AI:${p.name}] gagal: ${e.message}${pool.indexOf(p) < pool.length - 1 ? ' → coba provider berikutnya' : ''}`);
    }
  }
  throw lastErr || new Error('Semua AI provider gagal');
}

/** Chat dengan output JSON. Parse ke object. Throw kalau bukan JSON valid. */
async function chatJSON(opts) {
  const content = await chat({ ...opts, json: true });
  return JSON.parse(content);
}

module.exports = { hasKey, isEnabled, chat, chatJSON };
