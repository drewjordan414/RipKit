# Rip Kit

Turn a playlist CSV into a local ZIP of tagged audio files with **album art** and **metadata** (title, artist, album, year, genre). Everything runs **locally** on your machine.

Tired of streaming algorithms deciding what you should listen to? Tired of losing playlists, rising subscription prices, or limited offline access? Rip Kit lets you keep your music as files you own.

![Rip Kit](demo.png)

## What it does

- Takes a **playlist CSV** (Spotify, Apple Music, YouTube Music, custom, etc.)
- For each row, it:
  - Reads **title**, **artist**, **album**, **year**, **genre** (from many possible column names)
  - Searches the track on **YouTube**
  - Downloads the audio in the format you picked, using `youtube-dl-exec` / `yt-dlp`
  - Fetches square **album art** from the **iTunes Search API**
  - Writes tags and embeds the cover with `ffmpeg`
- Zips everything into `songs.zip` for you to download from the browser

## Formats

| Format | Re-encoded? | Album art | Notes |
| --- | --- | --- | --- |
| **Original** | No | Source-dependent | Keeps the source stream byte-for-byte. Highest quality available. |
| **MP3** | Yes | Yes | Plays on everything, including old iPods. ID3v2.3 + ID3v1. |
| **M4A** | Sometimes | Yes | Apple-native AAC. Often copied straight from the source. |
| **FLAC** | Yes | Yes | Lossless container — but see the caveat below. |
| **WAV** | Yes | No | Uncompressed. The container cannot hold cover art. |
| **OPUS** | Sometimes | No | Smallest at good quality. Newer players only. |

**On "high quality":** the source is a lossy YouTube stream (typically ~130 kbps Opus). Transcoding that to 320 kbps MP3 or FLAC gives you a bigger file, not a better one — you are re-encoding lossy audio a second time. **Original** is the only setting that avoids that, and the app reports the real codec and bitrate of each file as it downloads.

## How it works

- **Upload:** the CSV is stored briefly in `uploads/` by `multer`
- **Search:** `yt-search` finds the best matching YouTube video for each track
- **Download:** `youtube-dl-exec` (yt-dlp) pulls the best audio-only stream into a temp folder like `mp3s_123456789/`. Unless you pick **Original**, yt-dlp shells out to ffmpeg to transcode into your chosen format.
- **Covers:** iTunes Search API provides square artwork, saved temporarily then embedded
- **Tagging:** a second `ffmpeg` pass (`-c copy`, no re-encode) writes the tags and attaches the cover
- **Packaging:** `archiver` builds a ZIP and streams it back to your browser

## Install & run

### Node.js

https://nodejs.org — version 18 or newer.

### ffmpeg

ffmpeg does the tagging, cover embedding, and format conversion. `ffprobe` (bundled with it) reports the real bitrate of each download.

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
```

### Run

```bash
git clone https://github.com/drewjordan414/csv-music-downloader.git
cd csv-music-downloader

npm install
npm start          # builds the UI, then serves it at http://localhost:3000
```

For UI work, run the API and the Vite dev server side by side:

```bash
npm run server     # API on :3000
npm run dev        # UI on :5173 with hot reload, proxying to :3000
```

Check the format tagging logic without downloading anything:

```bash
node test-formats.js
```

## How to use

1. Export your playlist as a CSV — [Chosic](https://www.chosic.com/spotify-playlist-exporter/) does it for Spotify, or use any service that gives you title and artist columns
2. Open http://localhost:3000
3. Drop the CSV in, pick a format and bitrate
4. Watch the wheel fill — it shows the current track and its real codec/bitrate
5. Your browser downloads `songs.zip` with clean filenames, embedded covers, and tags

## Stack

React 19 + Vite on the front, Express 5 on the back, yt-dlp and ffmpeg doing the actual work.

## Disclaimer

This tool is intended only for personal, local use.

- Do not use this project to infringe copyright, redistribute music, or share copyrighted material without permission.
- You are solely responsible for how you use this code and for complying with your local laws and the terms of service of any platforms you access.
