# 🎭 CosTeleBot (Ultimate Multi-Source Scraper Bot)

![Cosplay Scraper](https://img.shields.io/badge/Node.js-Telegram_Bot-blue)
![Version](https://img.shields.io/badge/Version-2.0.0--Apex-success)
![Build](https://img.shields.io/badge/Build-Passing-brightgreen)
![Sources](https://img.shields.io/badge/Sources-5_Engines-orange)

**CosTeleBot** adalah *engine* Telegram Bot multi-fungsional tingkat lanjut (Advanced) yang dirancang untuk menelusuri, mengekstrak, dan mengirimkan arsip *High Quality Cosplay, Patreon Leaks, dan Animasi 3D* dari berbagai sumber secara otomatis. Ditulis dengan Node.js dan dioptimalkan untuk server/VPS *low-end* dengan efisiensi memori ekstrem.

---

## 🔥 Fitur Utama (Features)

### 📚 Cosplaytele Engine
🔹 **Interactive Browser:** Jelajahi ribuan *gallery* langsung dari chat Telegram dengan *pagination* pintar.  
🔹 **Search Engine:** Pencarian karakter/cosplayer secara interaktif maupun langsung via `/search <query>`.  
🔹 **Gacha Mode (Random SSR):** Tekan `/gacha` untuk bot menerjunkan dirinya ke halaman acak dan mengembalikan *Thumbnail SSR* kejutan!

### 🍁 Patreon Vault (Kemono.cr)
🔹 **Kemono Scraper:** Menembus dinding Cloudflare menggunakan Playwright untuk mengekstrak konten kreator Patreon yang diarsipkan di `Kemono.cr`.  
🔹 **Gacha Kreator Pool:** Sistem randomisasi dari kumpulan kreator eksklusif via `/maple`.  
🔹 **Local Download Pipeline:** File didownload ke server lokal terlebih dahulu, lalu diunggah ke Telegram sebagai stream offline — mengatasi blokir CDN Cloudflare!  
🔹 **Auto-Clear Reroll:** Saat Reroll, media gacha sebelumnya otomatis terhapus dari chat.

### 🎬 Rule34Video Engine
🔹 **Video Browser:** Jelajahi katalog video terbaru dengan navigasi halaman interaktif.  
🔹 **Search by Tag:** Cari video berdasarkan tag/karakter spesifik via `/r34 <query>`.  
🔹 **Video Gacha:** Mode acak untuk mendapat video kejutan dari seluruh database.  
🔹 **Auto-Fallback Resolution:** Jika video 1080p melebihi batas 50MB Telegram, bot otomatis turun ke 720p → 480p → 360p hingga menemukan ukuran yang aman.  
🔹 **Thumbnail Preview:** Lihat cover video dan detail resolusi sebelum memutuskan untuk mendownload.

### ⬇️ Multi-Source Downloader
🔹 **Gofile Extractor:** Deteksi otomatis folder Gofile, mendukung pemilihan file spesifik dari daftar isi.  
🔹 **MediaFire Downloader:** Mengekstrak tautan asli (termasuk yang di-*scramble* via Base64).  
🔹 **SoraFolder Bypasser:** Playwright API menipu *timer limit* 10 detik SoraFolder untuk mengekstrak direct link.  
🔹 **TeraBox / 4KHD Resolver:** Menembus antrean password TeraBox menggunakan xAPIverse.

### 🚦 Queue Manager & Telemetry
🔹 **Antrean Pintar (Queue System):** Mencegah kelebihan beban *server* akibat eksekusi massal pengguna. Secara bawaan membatasi maks 2 unduhan bersamaan dan perlindungan spam antrean *(maks 3 tugas per pengguna)*.  
🔹 **Aktivitas RPG Hunter (`statsDb`):** Telemetri *database* mencatat setiap tetes poin *Experience (EXP)* dari Gacha dan Kuota Media yang diklaim oleh pengguna, dengan sistem pangkat berlapis.  
🔹 **Dasbor Admin VPS:** Monitoring kondisi kesehatan Node.js dan RAM VPS murni dari Telegram untuk *Owner*.

### 🛡️ Optimasi & Stabilitas
🔹 **Sharp Compressor Engine:** Modul `sharp` merampingkan foto 4K raksasa demi mencegah error `PHOTO_INVALID_DIMENSIONS`.  
🔹 **Native OS Extraction:** Menggunakan `7z` dan `unrar` native OS (bukan WASM) untuk efisiensi RAM maksimal.  
🔹 **Media Chunker:** Kalkulasi otomatis payload 50MB Telegram, melindungi dari error `413 Request Entity Too Large`.  
🔹 **Auto-Clean UX:** Riwayat menu dan pesan status selalu disapu bersih secara otomatis.  
🔹 **Garbage Collector:** Mendukung `--expose-gc` untuk pembersihan memori manual di VPS low-end.

---

## 🚀 Panduan Instalasi (Deployment Guide)

### 1. Kebutuhan Sistem
- [Node.js](https://nodejs.org/en/) >= v18.0
- Package Manager (`npm`)
- Server VPS Linux (Ubuntu/Debian direkomendasikan)
- `p7zip-full` dan `unrar` (untuk ekstraksi arsip)

### 2. Cara Meng-install
```bash
# Clone Repositori
git clone https://github.com/fiore-cmd/costelebot.git
cd costelebot

# Install seluruh Pustaka Dependensi
npm install

# Install tools native OS (VPS Linux)
sudo apt install p7zip-full unrar -y

# Install Browser Engine untuk Scraper (Gofile & Kemono)
npx playwright install
```

### 3. Setup Konfigurasi Kunci (Environment Variables)
Buat file `.env` di root folder (sejajar dengan `package.json`):
```env
BOT_TOKEN=8xxxxxxx:AAFz...                       # Token Telegram Bot
XAPIVERSE_KEY=sk_882fd19...                      # Token Terabox Resolver 
```

---

## 🏃 Menjalankan Bot di VPS (PM2 Mode)

```bash
# Menyalakan untuk pertama kali (dengan GC support)
npx pm2 start telegram-bot.js --name "costelebot" --node-args="--expose-gc"

# Monitoring Log
npx pm2 logs costelebot

# Restart setelah update code
git pull origin main
npx pm2 restart costelebot
```

---

## 🎮 Command Tersedia

| Command | Deskripsi |
|---------|-----------|
| `/start` | Membuka Menu Utama interaktif |
| `/browse` | Jelajahi postingan Cosplaytele terbaru |
| `/search <query>` | Cari karakter/cosplayer di Cosplaytele |
| `/gacha` | 🎲 Gacha Cosplay acak (Surprise Me!) |
| `/maple` | 🍁 Gacha Patreon eksklusif dari Kemono.cr |
| `/r34` | 🎬 Menu Rule34Video (Browse, Search, Gacha) |
| `/r34 <tag>` | 🎬 Cari video Rule34 berdasarkan tag |
| `/tasks` | 🚦 Pantau Dasbor Antrean Eksekusi Server |
| `/stats` | 🔰 Lihat Profil Lisensi Hunter (Tingkat Pangkat & EXP) |
| `/stat` | 💻 Lihat Telemetri VPS & Memory (Khusus ID Admin) |
| `/clear` | 🧹 Hapus jejak 800 pesan terakhir di obrolan |

---

## 📁 Struktur Proyek

```
costelebot/
├── telegram-bot.js           # Main bot controller
├── scrapers/
│   ├── cosplaytele.js        # Scraper Cosplaytele
│   ├── gofile.js             # Extractor Gofile
│   ├── mediafire.js          # Downloader MediaFire
│   ├── sorafolder.js         # Bypasser SoraFolder (Playwright)
│   ├── kemono.js             # Scraper Kemono.cr (Playwright)
│   └── rule34video.js        # Scraper Rule34Video
├── statsDb.js                # Database Telemetri & Ranking User
├── .env                      # Environment variables (JANGAN DI-PUSH!)
├── package.json
└── README.md
```

---

> *Developed with ❤️ by Fiore.*
# CosTeleBot
