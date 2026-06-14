'use strict';

/**
 * Asisten percakapan bot (pakai Groq). Dipakai saat pesan user BUKAN permintaan
 * pencarian — bot membalas ramah dan mengarahkan ke command yang tepat.
 *
 * Daftar command di-inject dari registry (telegram-bot.js) supaya AI tahu persis
 * command apa saja yang tersedia dan tidak mengarang.
 */

const groq = require('./groqClient');

const PERSONA =
`Kamu "CosTeleBot", asisten ramah di dalam bot Telegram untuk mencari & mengunduh media (cosplay, anime, JAV, Pinterest, video dewasa, dll).
Gaya bicara: santai, akrab, Bahasa Indonesia, SINGKAT (maksimal 3-4 kalimat). Boleh pakai 1-2 emoji.

Tugasmu:
- Jawab sapaan, obrolan ringan, dan pertanyaan user soal cara pakai bot.
- Arahkan user ke command yang tepat HANYA dari DAFTAR COMMAND di bawah.
- Kalau user ingin mencari media, bilang cukup ketik kata kuncinya langsung (mis. "nami cosplay" atau "anime one piece") atau pakai command terkait.

Aturan:
- JANGAN mengarang command yang tidak ada di daftar.
- Tulis TEKS BIASA saja, tanpa Markdown/HTML (jangan pakai ** atau <b>).
- Jangan menjawab panjang lebar di luar fungsi bot.`;

/**
 * @param {string} userText  pesan user
 * @param {Array<{command:string, description:string}>} commands  daftar command
 * @returns {Promise<string>} balasan asisten (teks biasa)
 */
async function chatReply(userText, commands = []) {
  const cmdList = commands.length
    ? commands.map(c => `${c.command} — ${c.description}`).join('\n')
    : '(tidak ada command terdaftar)';
  const system = `${PERSONA}\n\nDAFTAR COMMAND TERSEDIA:\n${cmdList}`;

  return groq.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(userText).slice(0, 500) },
    ],
    temperature: 0.6,
    maxTokens: 250,
    timeoutMs: 12000,
  });
}

module.exports = { chatReply, assist };

// ─── ACTION ROUTER ────────────────────────────────────────────────────────────
// assist() = chatReply + kemampuan memilih SATU aksi untuk dijalankan bot.
// Output JSON divalidasi; default ke 'chat' kalau tidak yakin.
const ACTIONS = ['search', 'gacha', 'jav_gacha', 'browse', 'anime', 'menu', 'chat'];

/**
 * @returns {Promise<{action:string, query:string|null, source:string, reply:string}>}
 */
async function assist(userText, commands = []) {
  const cmdList = commands.length
    ? commands.map(c => `${c.command} — ${c.description}`).join('\n')
    : '(tidak ada)';

  const system = `${PERSONA}

Selain mengobrol, kamu bisa MENJALANKAN SATU aksi untuk user. Balas HANYA JSON (tanpa teks lain) dengan skema:
{ "action": "search" | "gacha" | "jav_gacha" | "browse" | "anime" | "menu" | "chat",
  "query": string | null,
  "source": "cosplay" | "r34" | "pinterest" | "jav" | "ero" | "anime" | "all" | null,
  "reply": string }

Panduan memilih action:
- "search"   → user mau cari media spesifik. Isi "query" (kata kunci) + "source".
- "anime"    → user mau cari/nonton anime. Isi "query" = judul anime.
- "gacha"    → user minta cosplay random ("kasih dong", "surprise", "acak").
- "jav_gacha"→ user minta JAV random.
- "browse"   → user mau lihat-lihat cosplay terbaru.
- "menu"     → user minta menu utama atau bingung mau apa.
- "chat"     → sapaan / obrolan / pertanyaan umum. Cukup isi "reply".
"reply" SELALU diisi kalimat ramah singkat (Bahasa Indonesia) yang menjelaskan aksimu / jawabanmu.

DAFTAR COMMAND TERSEDIA:
${cmdList}`;

  const parsed = await groq.chatJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(userText).slice(0, 500) },
    ],
    temperature: 0.4,
    maxTokens: 250,
    timeoutMs: 12000,
  });

  const action = ACTIONS.includes(parsed && parsed.action) ? parsed.action : 'chat';
  const validSrc = ['cosplay', 'r34', 'pinterest', 'jav', 'ero', 'anime', 'all'];
  return {
    action,
    query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim().slice(0, 150) : null,
    source: validSrc.includes(parsed.source) ? parsed.source : 'all',
    reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : '',
  };
}
