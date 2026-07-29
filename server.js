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
const progress = { total: 0, done: 0, current: '', detail: '' }

// what each output format can carry. cover art needs a container that holds a
// video stream (or FLAC pictures); id3 tags are mp3-only.
const FORMATS = {
  mp3: { cover: true, id3: true },
  m4a: { cover: true, id3: false },
  flac: { cover: true, id3: false },
  wav: { cover: false, id3: false },
  opus: { cover: false, id3: false },
  webm: { cover: false, id3: false } // only shows up via "original"
}

// "original" keeps whatever codec the source already used — no re-encode
const CHOICES = [...Object.keys(FORMATS), 'original']

// user input lands in a filename and an ffmpeg arg — only allow known values
function normalizeFormat (f) {
  const key = String(f || '').trim().toLowerCase()
  return CHOICES.includes(key) ? key : 'mp3'
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

// 1) Download audio only (no metadata, no thumbnail)
function downloadAudio (url, outputTemplate, userQuality, format) {
  const audioQuality = normalizeQuality(userQuality)

  const opts = {
    extractAudio: true, // -x / --extract-audio
    noPlaylist: true, // --no-playlist
    output: outputTemplate // -o "<folder>/<file>.%(ext)s"
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

  return youtubedl(url, opts)
}

// 2) Fetch album art from iTunes (square) and save as JPG
async function fetchAlbumArt (title, artist, tempFolder, fileBase) {
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
    let artUrl = json.results[0].artworkUrl100
    if (artUrl) {
      artUrl = artUrl.replace(/100x100bb\.jpg$/, '600x600bb.jpg')
    }

    const imgRes = await fetch(artUrl)
    if (!imgRes.ok) {
      console.log('Failed to download artwork:', artUrl)
      return null
    }

    const arrayBuffer = await imgRes.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const coverPath = `${tempFolder}/${fileBase}_cover.jpg`
    await fs.promises.writeFile(coverPath, buffer)

    return coverPath
  } catch (err) {
    console.log('Error fetching album art:', err)
    return null
  }
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

// Handle CSV upload → return ZIP
app.post('/upload', upload.single('csv'), async (req, res) => {
  const csvPath = req.file.path
  const songs = []
  const userQuality = req.body.quality || '0'
  const format = normalizeFormat(req.body.format)

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => songs.push(row))
    .on('end', async () => {
      const tempFolder = 'mp3s_' + Date.now()
      fs.mkdirSync(tempFolder)

      progress.total = songs.length
      progress.done = 0
      progress.current = ''
      progress.detail = ''

      for (const s of songs) {
        try {
          // UNIVERSAL FIELD DETECTION

          const title = getField(s, [
            'title',
            'Title',
            'track',
            'Track',
            'track_name',
            'Track Name',
            'trackName',
            'name',
            'Name',
            'song',
            'Song'
          ])

          const artist = getField(s, [
            'artist',
            'Artist',
            'artists',
            'Artists',
            'artist_name',
            'Artist Name',
            'singer',
            'Singer',
            'performer',
            'Performer'
          ])

          const album = getField(s, [
            'album',
            'Album',
            'album_name',
            'Album Name',
            'albumName',
            'record',
            'Record',
            'release',
            'Release'
          ])

          const year = getYear(s)
          const genre = getGenre(s)

          if (!title || !artist) {
            console.log('Skipping row (no title/artist):', s)
            progress.done++
            continue
          }

          const query = `${title} ${artist}`
          progress.current = query
          progress.detail = ''
          console.log('Searching:', query)

          const results = await yts(query)
          const video = results.videos[0]
          if (!video) {
            console.log('No video found for:', query)
            progress.done++
            continue
          }

          // filename ONLY from title, with spaces (no underscores)
          const fileBase = makeFileBaseFromTitle(title)

          // yt-dlp will write "<fileBase>.<ext>"
          const outputTemplate = `${tempFolder}/${fileBase}.%(ext)s`

          // 1) download pure audio
          await downloadAudio(video.url, outputTemplate, userQuality, format)

          const audioPath = findDownloaded(tempFolder, fileBase)
          if (!audioPath) {
            console.log('Download produced no file for:', query)
            continue
          }
          progress.detail = probeAudio(audioPath)

          // 2) fetch nice square album art (movie/album style)
          const coverPath = await fetchAlbumArt(
            title,
            artist,
            tempFolder,
            fileBase
          )

          // 3) apply metadata from CSV + embed cover
          try {
            await applyMetadataAndCover(audioPath, coverPath, {
              title, artist, album, year, genre
            })
            console.log('Tagged & Downloaded:', audioPath)
          } catch (tagErr) {
            console.log(
              'Tagging / cover error (keeping audio anyway):',
              tagErr
            )
          }

          // the cover jpg is scratch — never let it into the zip
          if (coverPath) {
            await fs.promises.unlink(coverPath).catch(() => {})
          }
        } catch (err) {
          console.log('Error downloading:', err)
        } finally {
          progress.done++
        }
      }

      progress.current = ''
      progress.detail = ''

      // when we're done, reset progress after a little while (optional)
      setTimeout(() => {
        progress.total = 0
        progress.done = 0
      }, 60_000)

      // Create ZIP to send to user
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename=songs.zip')

      const zip = archiver('zip')
      zip.pipe(res)
      zip.directory(tempFolder, false)
      zip.finalize()
    })
})

if (require.main === module) {
  app.listen(3000, () => console.log('Server running at http://localhost:3000'))
}

module.exports = { FORMATS, normalizeFormat, normalizeQuality, applyMetadataAndCover }
