# 🎭 CosTeleBot (Ultimate Multi-Source Scraper Bot)

![Node.js Telegram Bot](https://img.shields.io/badge/Node.js-Telegram_Bot-blue)
![Version](https://img.shields.io/badge/Version-3.0.0--Nexus-success)
![Build](https://img.shields.io/badge/Build-Passing-brightgreen)
![Sources](https://img.shields.io/badge/Sources-9_Engines-orange)
![AI](https://img.shields.io/badge/AI-Groq_+_DeepSeek-purple)

**CosTeleBot** adalah *engine* Telegram Bot multi-fungsi tingkat lanjut untuk menelusuri, mengekstrak, dan mengirimkan media (cosplay, anime, JAV, video dewasa, Patreon, Pinterest) dari banyak sumber secara otomatis. Ditulis dengan Node.js dan dioptimalkan untuk VPS *low-end* dengan efisiensi memori tinggi.

Cukup **ketik apa yang kamu mau** — bot pakai AI untuk mengerti & menjalankannya sendiri (atau pilih dari menu interaktif).

---

## 🔥 Fitur Utama

### 🤖 Asisten AI (Groq + DeepSeek)
- **Free-text → aksi:** ketik "cari ganyu", "gacha jav", "MIDE-232", "xnxx cosplay", atau "anime one piece" → bot langsung jalanin aksi yang tepat (search/gacha/browse/anime/menu).
- **Multi-provider + fallback:** Groq (Llama 3.3 70B, primary, gratis) → **DeepSeek** (`deepseek-v4-flash`, fallback otomatis kalau Groq down/rate-limit). Circuit breaker per-provider.
- **Memori percakapan:** ingat 2-3 pesan terakhir, jadi "tempel judul" lalu "cari di xnxx" (pesan terpisah) tetap nyambung.
- **Smart intent detection:** 2 layer (regex instan + LLM). Regex sudah deteksi **kode JAV** ("MIDE-232") & **leading-source** ("pinterest gintama", "r34 tifa") secara offline.
- **Routing pintar:** nama ambigu tanpa konteks → tawarkan semua sumber (bukan nebak); gacha per-sumber (cosplay/jav/ero/xnxx/kemono).
- Aktif kalau `GROQ_API_KEY` **atau** `DEEPSEEK_API_KEY` di-set; tanpa keduanya fallback ke regex.

### 📚 Cosplaytele Engine
- Interactive browser dengan pagination, search karakter/cosplayer, dan **Gacha** (random SSR).
- **More from cosplayer** pintar: name-match ke kategori, fallback ke pencarian nama.
- Multi-host download: Gofile, SoraFolder, MediaFire, TeraBox.

### 🎥 Javtiful (JAV)
- Search by kode JAV / aktris / tag, **Gacha** (random/trending/cosplay), explore aktris & kategori.
- Auto-split video > limit upload jadi beberapa part.

### 🔥 EroThots &  XNXX
- Search, **Browse terbaru**, dan **Gacha**.
- XNXX: download kualitas penuh via **HLS + ffmpeg** (fallback MP4 progresif). Detail kaya: **⭐ pornstar, 🏷️ tag, deskripsi** + tombol pornstar untuk lihat video lain dari artis itu.

### 🎬 Rule34Video
- Browse katalog, search by tag, video gacha, preview thumbnail + resolusi.

### 📌 Pinterest
- Search image & video. Video HLS di-download via **ffmpeg** (fix masalah 403 resolusi).

### 🎌 Anime Hub (Otakudesu + Oploverz + Kusonime)
- Search lintas 3 sumber, gacha ongoing/batch, latest releases, browse by season/genre.
- Resolver multi-host: Gofile, Mega, GDrive, Buzzheavier, Filedon.

### 🍁 Patreon Vault (Kemono.cr)
- Scraper Playwright (tembus Cloudflare), gacha kreator pool via `/maple`, download pipeline lokal.

### ⬇️ Multi-Source Downloader
- **Gofile** (resolver Playwright + proxy WARP opsional), **MediaFire**, **SoraFolder** (decrypt AES), **TeraBox/4KHD** (xAPIverse + fallback gratis), **Mega**, **GDrive**.

### 🎞️ Pengiriman Video Pintar
- **Streaming langsung:** semua video dikirim sebagai `sendVideo` + `supports_streaming` + **faststart remux** (ffmpeg) → bisa diputar tanpa download penuh.
- **Auto-split:** video > limit dipecah jadi part otomatis (ffmpeg `-c copy`).
- **Dedup file_id:** file yang sama dikirim ulang dari server Telegram tanpa download/upload ulang (hemat bandwidth).

### 🚦 Queue Manager & Telemetry
- **Antrean round-robin per-user** (fairness): default maks 6 unduhan bersamaan, 8 tugas per user (configurable via env).
- **Telemetri RPG** (`statsDb`): EXP dari gacha + kuota media, sistem pangkat.
- **Dasbor admin**: health check semua sumber, statistik VPS, web dashboard opsional.
- **Auto-notify watcher**: kabari admin saat ada post/episode baru.

### 🛡️ Optimasi & Stabilitas
- **Sharp compressor** untuk foto 4K, **native 7z/unrar** (bukan WASM), media chunker anti-413.
- **Browser reaper**: bunuh proses Chromium zombie (jaga RAM).
- **Startup env validation**, auto-clean UX, dukungan `--expose-gc`.

---

## 🚀 Panduan Instalasi

### 1. Kebutuhan Sistem
- [Node.js](https://nodejs.org/en/) >= v18 (disarankan 20+)
- VPS Linux (Ubuntu/Debian)
- `p7zip-full` + `unrar` (ekstraksi arsip)
- `ffmpeg` (split video, download HLS, faststart streaming)

### 2. Instalasi
```bash
git clone https://github.com/Aryoksss/CosTeleBot.git
cd CosTeleBot

npm install

# Tools native OS
sudo apt install -y p7zip-full unrar ffmpeg

# Browser engine (dipakai Gofile & Kemono)
npx playwright install chromium
```

### 3. Konfigurasi `.env`
Buat file `.env` di root (lihat `.env.example` untuk daftar lengkap):
```env
BOT_TOKEN=8xxxxxxx:AAFz...              # WAJIB — Token Telegram Bot
XAPIVERSE_KEY=sk_882fd19...             # Terabox resolver
ADMIN_IDS=6663343995                    # CSV ID admin
GROQ_API_KEY=gsk_xxx                    # Opsional — aktifkan AI assistant & smart search
DEEPSEEK_API_KEY=sk-xxx                 # Opsional — fallback AI (deepseek-v4-flash)
# GOFILE_PROXY=socks5://127.0.0.1:40000 # Opsional — WARP proxy untuk Gofile
# LOCAL_API_URL=http://127.0.0.1:8081   # Opsional — Local Bot API (upload s/d 2GB)
```

Lihat `.env.example` untuk tuning antrean, watcher, dashboard, faststart, split, dll.

---

## 🏃 Menjalankan di VPS (PM2)

```bash
# Pertama kali
npx pm2 start ecosystem.config.js
# atau manual:
npx pm2 start telegram-bot.js --name "costelebot" --node-args="--expose-gc"

# Monitoring
npx pm2 logs costelebot

# Update manual
git pull origin main && npx pm2 reload costelebot
```

> 💡 **CI/CD:** push ke branch `main` otomatis ter-deploy ke VPS via GitHub Actions (cek syntax → SSH → `deploy.sh` → PM2 reload → notif Telegram). Lihat `DEPLOY.md`.

---

## 🎮 Command Tersedia

| Command | Deskripsi |
|---------|-----------|
| `/start` | Buka Menu Utama interaktif |
| `/browse` | Jelajahi postingan Cosplaytele terbaru |
| `/search <query>` | Cari karakter/cosplayer (pilih sumber) |
| `/gacha` | 🎲 Gacha Cosplay random |
| `/maple` | 🍁 Gacha Patreon (Kemono.cr) |
| `/r34 [tag]` | 🎬 Rule34Video (Browse/Search/Gacha) |
| `/jav [query]` | 🎥 Javtiful (Search/Gacha/Trending) |
| `/ero [query]` | 🔥 EroThots (Search/Browse/Gacha) |
| `/xnxx [query]` | 🟦 XNXX (Search/Browse/Gacha) |
| `/pin <query>` | 📌 Pinterest (image/video) |
| `/anime [judul]` | 🎌 Anime (Otakudesu + Oploverz + Kusonime) |
| `/tasks` | 🚦 Pantau antrean eksekusi |
| `/stats` | 🔰 Profil Hunter (pangkat & EXP) |
| `/health` (`/ping`) | 🏥 Cek kesehatan bot + semua sumber |
| `/backup` | 💾 Export data kamu (JSON) |
| `/clear` | 🧹 Bersihkan riwayat chat |
| `/stat` | 💻 Statistik VPS (admin) |
| `/watch` | 🔔 Status auto-notify post baru (admin) |
| `/notif` | 🔔 Push notification (admin) |

> 💬 Atau cukup **ketik bebas** seperti `cari rem cosplay`, `gacha jav`, `MIDE-232`, `xnxx cosplay`, `anime frieren` — AI akan menjalankannya.

---

## 📁 Struktur Proyek

```
costelebot/
├── telegram-bot.js           # Main controller (command registry, queue, send pipeline)
├── assistant.js              # AI conversational + action router (Groq)
├── intentDetector.js         # Deteksi intent free-text (regex + LLM)
├── groqClient.js             # Client LLM multi-provider (Groq + DeepSeek fallback)
├── statsDb.js / history.js   # Telemetri user + anti-repeat gacha
├── ecosystem.config.js       # Konfigurasi PM2
├── deploy.sh                 # Script auto-deploy VPS
├── scrapers/
│   ├── cosplaytele.js        # Cosplaytele
│   ├── javtiful.js           # Javtiful (JAV)
│   ├── erothots.js           # EroThots
│   ├── xnxx.js               # XNXX
│   ├── rule34video.js        # Rule34Video
│   ├── pinterest.js          # Pinterest
│   ├── kemono.js             # Kemono.cr (Playwright)
│   ├── otakudesu.js / oploverz.js / kusonime.js   # Anime
│   ├── gofile.js             # Gofile (Playwright)
│   ├── mediafire.js / sorafolder.js / teraboxResolver.js
│   ├── megaResolver.js / gdriveResolver.js / hostResolver.js
├── utils/
│   ├── fileCache.js          # Dedup file_id Telegram
│   ├── browserReaper.js      # Pembersih Chromium zombie
│   ├── healthcheck.js / watcher.js / dashboard.js / backup.js / progressUi.js
├── .github/workflows/deploy.yml   # CI/CD auto-deploy
├── .env                      # Environment (JANGAN DI-PUSH)
├── package.json
└── README.md
```

---

> *Multi-source media engine — dibangun untuk efisiensi VPS low-end.*
