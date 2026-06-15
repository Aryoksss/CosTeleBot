'use strict';

/**
 * Asisten percakapan + action router bot (pakai LLM via groqClient: Groq/DeepSeek).
 *
 * assist() memilih SATU aksi untuk dijalankan bot dari pesan bebas user, plus balasan ramah.
 * Daftar command di-inject dari registry (telegram-bot.js) supaya AI tidak mengarang.
 */

const groq = require('./groqClient');

const PERSONA =
`Kamu "CosTeleBot", asisten di dalam bot Telegram untuk MENCARI & MENGUNDUH media dari banyak sumber.
Gaya: santai, akrab, Bahasa Indonesia, SINGKAT (maks 2-3 kalimat). Boleh 1-2 emoji.
Tulis TEKS BIASA (tanpa Markdown/HTML). Jangan mengarang command/fitur yang tidak ada.`;

// Deskripsi lengkap kemampuan bot — supaya AI benar-benar paham seluruh konteks project.
const CAPABILITIES =
`SUMBER & KEGUNAANNYA:
- cosplay  = Cosplaytele. Album foto/video cosplay (karakter, cosplayer). Contoh: "ganyu cosplay", "byoru".
- jav      = Javtiful. Video JAV. Kenali KODE JAV (mis. MIDE-232, SSNI-001, ABP-123) dan nama aktris Jepang.
- ero      = EroThots. Video amatir / OnlyFans leak.
- xnxx     = XNXX. Tube video dewasa umum (segala kategori).
- r34      = Rule34Video. Video rule34 / hentai berbasis tag/karakter.
- pinterest= Pinterest. Gambar & video pendek (apa saja, termasuk SFW).
- anime    = Streaming/unduh anime sub Indo (Otakudesu/Oploverz/Kusonime). Contoh: "anime frieren", "one piece episode".
- kemono   = Patreon/Kemono. Konten kreator Patreon (gacha saja).
- all      = cari di banyak sumber sekaligus (kalau user tidak menyebut sumber).

AKSI YANG BISA KAMU JALANKAN (field "action"):
- "search"  : user mau cari sesuatu. Isi "query" (kata kunci inti) + "source" (tebak paling cocok).
              Kalau user menyebut sumber tapi BELUM kasih kata kunci (mis. "carikan di xnxx"),
              tetap action="search", "source"="xnxx", "query"=null → bot akan menanyakan kata kuncinya.
- "anime"   : khusus cari anime. "query" = judul anime.
- "gacha"   : user minta acak/random/surprise. "source" menentukan jenis gacha:
              cosplay (default), jav, ero, xnxx, kemono. Contoh "gacha jav" → action=gacha, source=jav.
- "browse"  : user mau lihat-lihat cosplay terbaru (tanpa kata kunci).
- "menu"    : user minta menu utama / bingung.
- "chat"    : sapaan / obrolan / pertanyaan cara pakai. Cukup isi "reply".

ATURAN PENTING:
- Perbaiki typo pada query, TAPI pertahankan nama diri (karakter/cosplayer/judul/aktris) & bahasa aslinya. Jangan menerjemahkan.
- Normalisasi kode JAV ke huruf besar + tanda hubung: "mide232"/"mide 232" → "MIDE-232".
- Kalau user menempel judul/kalimat panjang lalu minta "cari di <sumber>", anggap judul itu sebagai "query".
- Kalau ragu sumbernya, pakai "all".
- "reply" SELALU diisi kalimat ramah singkat (Bahasa Indonesia).

CONTOH (input → output JSON):
- "hai" → {"action":"chat","query":null,"source":null,"reply":"Hai! Mau cari apa hari ini? 😄"}
- "ganyu cosplay" → {"action":"search","query":"ganyu","source":"cosplay","reply":"Oke, cariin cosplay Ganyu ya!"}
- "MIDE 232" → {"action":"search","query":"MIDE-232","source":"jav","reply":"Sip, cek kode JAV MIDE-232."}
- "cari naruto di xnxx" → {"action":"search","query":"naruto","source":"xnxx","reply":"Oke, cari 'naruto' di XNXX."}
- "carikan di xnxx" → {"action":"search","query":null,"source":"xnxx","reply":"Boleh, mau cari apa di XNXX?"}
- "anime frieren" → {"action":"anime","query":"frieren","source":"anime","reply":"Cariin anime Frieren!"}
- "gacha jav dong" → {"action":"gacha","query":null,"source":"jav","reply":"Gacha JAV jalan! 🎲"}
- "kasih cosplay random" → {"action":"gacha","query":null,"source":"cosplay","reply":"Gacha cosplay! 🎲"}
- "menu" → {"action":"menu","query":null,"source":null,"reply":"Ini menu utamanya 👇"}`;

const ACTIONS = ['search', 'gacha', 'jav_gacha', 'browse', 'anime', 'menu', 'chat'];
const VALID_SRC = ['cosplay', 'r34', 'pinterest', 'jav', 'ero', 'xnxx', 'anime', 'kemono', 'all'];

/**
 * Balasan obrolan teks biasa (tanpa aksi). Dipakai untuk fallback ringan.
 * @returns {Promise<string>}
 */
async function chatReply(userText, commands = []) {
  const cmdList = commands.length ? commands.map(c => `${c.command} — ${c.description}`).join('\n') : '(tidak ada)';
  const system = `${PERSONA}\n\n${CAPABILITIES}\n\nDAFTAR COMMAND:\n${cmdList}`;
  return groq.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(userText).slice(0, 500) },
    ],
    temperature: 0.6, maxTokens: 200, timeoutMs: 12000,
  });
}

/**
 * Pilih satu aksi + balasan dari pesan bebas user.
 * @param {string} userText
 * @param {Array}  commands  daftar command dari registry
 * @param {Array}  history   riwayat percakapan terakhir [{role:'user'|'assistant', content}]
 *                           dipakai supaya konteks lintas-pesan nyambung (mis. tempel judul
 *                           lalu "cari di xnxx").
 * @returns {Promise<{action:string, query:string|null, source:string, reply:string}>}
 */
async function assist(userText, commands = [], history = []) {
  const cmdList = commands.length ? commands.map(c => `${c.command} — ${c.description}`).join('\n') : '(tidak ada)';
  const system = `${PERSONA}

Balas HANYA JSON (tanpa teks lain) dengan skema:
{ "action": "search"|"gacha"|"browse"|"anime"|"menu"|"chat", "query": string|null, "source": "cosplay"|"r34"|"pinterest"|"jav"|"ero"|"xnxx"|"anime"|"kemono"|"all"|null, "reply": string }

${CAPABILITIES}

GUNAKAN KONTEKS PERCAKAPAN: kalau pesan terakhir user merujuk ke pesan sebelumnya
(mis. user menempel judul/teks lalu berkata "cari di xnxx" / "yang ini di jav"),
ambil judul/teks dari pesan sebelumnya sebagai "query".

DAFTAR COMMAND TERSEDIA:
${cmdList}`;

  // Sertakan maksimal 4 turn terakhir sebagai konteks.
  const hist = Array.isArray(history) ? history.slice(-4).filter(h => h && h.role && h.content) : [];
  const messages = [
    { role: 'system', content: system },
    ...hist.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 400) })),
    { role: 'user', content: String(userText).slice(0, 500) },
  ];

  const parsed = await groq.chatJSON({ messages, temperature: 0.3, maxTokens: 250, timeoutMs: 12000 });

  let action = ACTIONS.includes(parsed && parsed.action) ? parsed.action : 'chat';
  if (action === 'jav_gacha') action = 'gacha'; // normalisasi alias lama
  return {
    action,
    query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim().slice(0, 150) : null,
    source: VALID_SRC.includes(parsed.source) ? parsed.source : 'all',
    reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : '',
  };
}

module.exports = { chatReply, assist };
