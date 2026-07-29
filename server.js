const express = require('express')
const multer = require('multer')
const fs = require('fs')
const csv = require('csv-parser')
const yts = require('yt-search')
const archiver = require('archiver')
const youtubedl = require('youtube-dl-exec')
const { spawn, execFileSync } = require('child_process')
const path = require('path')

const app = express()
const upload = multer({ dest: 'uploads/' })

// serve the built React app (npm run build)
app.use(express.static('dist'))

// simple in-memory progress tracker (single-user / local use)
const progress = { total: 0, done: 0, tracks: [] }

// What each container can carry, for tagging. This covers more formats than
// we offer as conversion targets, because "original" hands back whatever
// codec the source used — usually opus or m4a, occasionally webm.
const FORMATS = {
  mp3: { cover: true, id3: true },
  m4a: { cover: true, id3: false },
  flac: { cover: true, id3: false },
  wav: { cover: false, id3: false },
  opus: { cover: false, id3: false },
  webm: { cover: false, id3: false }
}

// What a user may actually pick.
//
// The source is always a lossy stream, so re-encoding it can only lose data.
// Measured against a 387 kbps AAC source: flac came back at 2942 kbps and wav
// at 4608 kbps — 7.6x and 11.9x the bitrate for bit-identical audio content.
// m4a and opus re-encode to roughly the source's own size while adding a
// second generation of loss, which is strictly worse than keeping the
// original. That leaves two honest choices: keep the source as-is, or convert
// to mp3 because your player cannot read opus or aac.
const CHOICES = ['original', 'mp3']

// user input lands in a filename and an ffmpeg arg — only allow known values
function normalizeFormat (f) {
  const key = String(f || '').trim().toLowerCase()
  return CHOICES.includes(key) ? key : 'original'
}

// "original" means we don't know the extension until yt-dlp has written the file
function findDownloaded (folder, fileBase) {
  const hit = fs
    .readdirSync(folder)
    .find((f) => f.startsWith(fileBase + '.') && !f.includes('.tagged.'))
  return hit ? `${folder}/${hit}` : null
}

// what ffmpeg actually produced, so we can report real quality instead of the request
function probeAudio (file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file
    ])
    const info = JSON.parse(out)
    const audio = info.streams.find((s) => s.codec_type === 'audio')
    if (!audio) return ''
    const kbps = Math.round((audio.bit_rate || info.format.bit_rate || 0) / 1000)
    return kbps ? `${audio.codec_name} · ${kbps} kbps` : audio.codec_name
  } catch {
    return ''
  }
}

// normalize user-entered quality (e.g. "128" -> "128K", "best" -> "0")
function normalizeQuality (q) {
  if (!q) return '0' // default: best VBR
  q = String(q).trim().toLowerCase()

  if (q === 'best' || q === '0') return '0' // yt-dlp: 0 = best VBR
  if (/^\d+$/.test(q)) return q + 'K' // "128" -> "128K"
  if (/^\d+k$/.test(q)) return q.toUpperCase() // "128k" -> "128K"

  return '0'
}

// turn song title into a safe filename WITH SPACES (no slashes etc)
function makeFileBaseFromTitle (title) {
  return String(title)
    .replace(/[\/\\?%*:|"<>]/g, ' ') // remove path-unsafe chars
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .trim()
}

// helper: get first non-empty field from a list of possible column names
function getField (row, candidates) {
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] != null) {
      const val = String(row[key]).trim()
      if (val) return val
    }
  }
  return ''
}

// helper: derive year from multiple possible fields
function getYear (row) {
  // direct year-ish fields
  const directYearRaw = getField(row, [
    'year',
    'Year',
    'release_year',
    'Release Year',
    'ReleaseYear',
    'published_year',
    'Published Year'
  ])

  if (directYearRaw) {
    const m = String(directYearRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  // album / release date style fields
  const albumDateRaw = getField(row, [
    'albumdate',
    'AlbumDate',
    'album_date',
    'album date',
    'album_release_date',
    'Album Release Date',
    'release_date',
    'Release Date',
    'released_at',
    'Released At',
    'date',
    'Date'
  ])

  if (albumDateRaw) {
    const m = String(albumDateRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  return ''
}

// helper: get genre from multiple possible fields
function getGenre (row) {
  return getField(row, [
    'genre',
    'Genre',
    'genres',
    'Genres',
    'style',
    'Style',
    'mood',
    'Mood'
  ])
}

// 1) Download audio only (no metadata, no thumbnail).
// onPercent gets yt-dlp's real download percentage as it streams.
function downloadAudio (url, outputTemplate, userQuality, format, onPercent) {
  const audioQuality = normalizeQuality(userQuality)

  const opts = {
    extractAudio: true, // -x / --extract-audio
    noPlaylist: true, // --no-playlist
    output: outputTemplate, // -o "<folder>/<file>.%(ext)s"
    newline: true, // --newline: one progress line per update, not \r
    progress: true // --progress: report even though this is not a tty
    // NOTE: no embedThumbnail / addMetadata here
  }

  if (format === 'original') {
    // best audio stream, container remuxed but codec untouched — no second
    // lossy generation. This is the highest quality the source can give.
    opts.format = 'bestaudio/best'
  } else {
    opts.audioFormat = format // --audio-format mp3 / m4a / flac / …
    opts.audioQuality = audioQuality // --audio-quality (0-10 or "128K" etc)
  }

  const sub = youtubedl.exec(url, opts)

  sub.stdout?.on('data', (chunk) => {
    const pct = parseProgress(chunk)
    if (pct !== null) onPercent(pct)
  })

  return sub
}

// yt-dlp writes "[download]  45.2% of ~3.50MiB at 1.20MiB/s ETA 00:02".
// A chunk can hold several updates — only the last one is current.
function parseProgress (chunk) {
  const hits = String(chunk).match(/\[download\]\s+([\d.]+)%/g)
  if (!hits) return null
  const pct = parseFloat(hits[hits.length - 1].match(/([\d.]+)%/)[1])
  return Number.isNaN(pct) ? null : pct
}

// 2a) Ask iTunes for a square cover URL. Cheap enough to run before a rip so
// the tracklist can show artwork while everything is still queued.
async function lookupArt (title, artist) {
  try {
    const term = `${title} ${artist}`
    const apiURL = `https://itunes.apple.com/search?term=${encodeURIComponent(
      term
    )}&entity=song&limit=1`

    const res = await fetch(apiURL)
    if (!res.ok) {
      console.log('iTunes search failed:', res.status)
      return null
    }

    const json = await res.json()
    if (!json.results || !json.results.length) {
      console.log('No iTunes result for:', term)
      return null
    }

    // artworkUrl100 is square 100x100; we can often get a larger square:
    // .../100x100bb.jpg -> .../600x600bb.jpg
    const artUrl = json.results[0].artworkUrl100
    return artUrl ? artUrl.replace(/100x100bb\.jpg$/, '600x600bb.jpg') : null
  } catch (err) {
    console.log('Error looking up album art:', err)
    return null
  }
}

// 2b) Download that cover to disk so ffmpeg can embed it
async function saveArt (artUrl, tempFolder, fileBase) {
  if (!artUrl) return null
  try {
    const imgRes = await fetch(artUrl)
    if (!imgRes.ok) {
      console.log('Failed to download artwork:', artUrl)
      return null
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer())
    const coverPath = `${tempFolder}/${fileBase}_cover.jpg`
    await fs.promises.writeFile(coverPath, buffer)
    return coverPath
  } catch (err) {
    console.log('Error saving album art:', err)
    return null
  }
}

// Pull the fields we care about out of one CSV row, whatever it calls them
function toTrack (row) {
  return {
    title: getField(row, [
      'title', 'Title', 'track', 'Track', 'track_name', 'Track Name',
      'trackName', 'name', 'Name', 'song', 'Song'
    ]),
    artist: getField(row, [
      'artist', 'Artist', 'artists', 'Artists', 'artist_name', 'Artist Name',
      'singer', 'Singer', 'performer', 'Performer'
    ]),
    album: getField(row, [
      'album', 'Album', 'album_name', 'Album Name', 'albumName',
      'record', 'Record', 'release', 'Release'
    ]),
    year: getYear(row),
    genre: getGenre(row)
  }
}

function parseCsv (csvPath) {
  return new Promise((resolve, reject) => {
    const rows = []
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows.map(toTrack)))
      .on('error', reject)
  })
}

// 3) Use ffmpeg to apply metadata + optional cover art
function applyMetadataAndCover (audioPath, coverPath, meta) {
  return new Promise((resolve, reject) => {
    // trust the file on disk, not the requested format — "original" only
    // learns its container once yt-dlp has written it
    const ext = path.extname(audioPath).slice(1).toLowerCase()
    const caps = FORMATS[ext] || { cover: false, id3: false }
    const embedCover = Boolean(coverPath) && caps.cover

    // Keep the extension so ffmpeg still picks the right muxer
    const tempOut = audioPath.replace(new RegExp(`\\.${ext}$`, 'i'), `.tagged.${ext}`)

    const args = []

    // overwrite output if exists
    args.push('-y')

    // INPUTS
    args.push('-i', audioPath) // audio
    if (embedCover) {
      args.push('-i', coverPath) // cover image
    }

    // MAPS
    if (embedCover) {
      // map audio & image
      args.push('-map', '0:a')
      args.push('-map', '1:v')
    } else {
      args.push('-map', '0:a')
    }

    // copy streams, don't re-encode
    args.push('-c', 'copy')

    if (caps.id3) {
      // ensure proper ID3v2 + write ID3v1 for older players/iPods
      args.push('-id3v2_version', '3')
      args.push('-write_id3v1', '1')
    }

    // metadata from CSV
    if (meta.title) args.push('-metadata', `title=${meta.title}`)
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`)
    if (meta.album) args.push('-metadata', `album=${meta.album}`)
    if (meta.genre) args.push('-metadata', `genre=${meta.genre}`)

    if (meta.year) {
      // "year" is the ID3v2.3 field; "date" is what mp4/vorbis containers read
      if (caps.id3) args.push('-metadata', `year=${meta.year}`)
      args.push('-metadata', `date=${meta.year}`)
    }

    // extra tags for cover
    if (embedCover) {
      args.push('-disposition:v', 'attached_pic')
      args.push('-metadata:s:v', 'title=Album cover')
      args.push('-metadata:s:v', 'comment=Cover (front)')
    }

    // OUTPUT
    args.push(tempOut)

    const ff = spawn('ffmpeg', args)

    ff.stderr.on('data', (d) => {
      // ffmpeg logs – useful for debugging
      process.stderr.write(d.toString())
    })

    ff.on('close', (code) => {
      if (code === 0) {
        // Replace original file with tagged version
        fs.promises.rename(tempOut, audioPath).then(resolve).catch(reject)
      } else {
        // clean up temp on error
        fs.promises
          .unlink(tempOut)
          .catch(() => {})
          .finally(() => {
            reject(new Error('ffmpeg exited with code ' + code))
          })
      }
    })

    ff.on('error', (err) => reject(err))
  })
}

// Simple endpoint for polling progress from frontend
app.get('/progress', (req, res) => {
  res.json(progress)
})

// Read the CSV and hand back the tracklist (with cover art) before ripping,
// so the page can show what it is about to do.
app.post('/preview', upload.single('csv'), async (req, res) => {
  try {
    const tracks = await parseCsv(req.file.path)

    // iTunes is fast but we still have one call per track — run them together
    const withArt = await Promise.all(
      tracks.map(async (t) => ({
        ...t,
        art: t.title && t.artist ? await lookupArt(t.title, t.artist) : null,
        status: t.title && t.artist ? 'queued' : 'skipped'
      }))
    )

    res.json({ tracks: withArt })
  } catch (err) {
    console.log('Preview failed:', err)
    res.status(400).json({ error: 'Could not read that CSV.' })
  } finally {
    fs.promises.unlink(req.file.path).catch(() => {})
  }
})

// Handle CSV upload → return ZIP
app.post('/upload', upload.single('csv'), async (req, res) => {
  const userQuality = req.body.quality || '0'
  const format = normalizeFormat(req.body.format)

  const songs = await parseCsv(req.file.path)
  const tempFolder = 'mp3s_' + Date.now()
  fs.mkdirSync(tempFolder)

  progress.total = songs.length
  progress.done = 0
  progress.tracks = songs.map((s) => ({
    status: s.title && s.artist ? 'queued' : 'skipped',
    detail: s.title && s.artist ? '' : 'No title or artist in this row',
    percent: 0
  }))

  for (const [i, s] of songs.entries()) {
    const track = progress.tracks[i]
    const { title, artist, album, year, genre } = s

    if (!title || !artist) {
      console.log('Skipping row (no title/artist)')
      progress.done++
      continue
    }

    track.status = 'working'
    track.detail = 'searching youtube'
    track.percent = 0

    try {
      const query = `${title} ${artist}`
      console.log('Searching:', query)

      const results = await yts(query)
      const video = results.videos[0]
      if (!video) {
        track.status = 'failed'
        track.detail = 'No match on YouTube'
        console.log('No video found for:', query)
        continue
      }

      // filename ONLY from title, with spaces (no underscores)
      const fileBase = makeFileBaseFromTitle(title)
      const outputTemplate = `${tempFolder}/${fileBase}.%(ext)s`

      // 1) download pure audio. The download is the long part, so it owns
      // most of the bar; tagging tops off the rest.
      track.detail = 'downloading audio'
      await downloadAudio(video.url, outputTemplate, userQuality, format, (pct) => {
        track.percent = Math.round(pct * 0.9)
      })

      const audioPath = findDownloaded(tempFolder, fileBase)
      if (!audioPath) {
        track.status = 'failed'
        track.detail = 'Download produced no file'
        console.log('Download produced no file for:', query)
        continue
      }

      // 2) cover art, then 3) metadata + embed
      track.detail = 'tagging'
      track.percent = 95
      const artUrl = await lookupArt(title, artist)
      const coverPath = await saveArt(artUrl, tempFolder, fileBase)

      try {
        await applyMetadataAndCover(audioPath, coverPath, {
          title, artist, album, year, genre
        })
        console.log('Tagged & Downloaded:', audioPath)
      } catch (tagErr) {
        console.log('Tagging / cover error (keeping audio anyway):', tagErr)
      }

      // the cover jpg is scratch — never let it into the zip
      if (coverPath) {
        await fs.promises.unlink(coverPath).catch(() => {})
      }

      track.status = 'done'
      track.detail = probeAudio(audioPath)
      track.percent = 100
    } catch (err) {
      track.status = 'failed'
      track.detail = String(err.message || err).slice(0, 120)
      console.log('Error downloading:', err)
    } finally {
      progress.done++
    }
  }

  // when we're done, reset progress after a little while (optional)
  setTimeout(() => {
    progress.total = 0
    progress.done = 0
    progress.tracks = []
  }, 60_000)

  // Create ZIP to send to user
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename=songs.zip')

  const zip = archiver('zip')
  zip.pipe(res)
  zip.directory(tempFolder, false)
  zip.finalize()
})

if (require.main === module) {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'))
}

module.exports = {
  FORMATS, normalizeFormat, normalizeQuality, applyMetadataAndCover, parseProgress
}
