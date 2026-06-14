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

module.exports = { chatReply };
