// Checks the per-format tagging branch without downloading anything:
// synthesize a second of silence in each format, tag it, read the tags back.
// Run: node test-formats.js   (needs ffmpeg + ffprobe on PATH)

const assert = require('assert')
const fs = require('fs')
const { execFileSync } = require('child_process')
const ytdl = require('youtube-dl-exec')
const {
  FORMATS, normalizeFormat, normalizeQuality, applyMetadataAndCover, parseProgress
} = require('./server')

const DIR = 'test_tmp'
const META = { title: 'Test Track', artist: 'Test Artist', album: 'Test Album', year: '1999', genre: 'Rock' }

function ffprobe (file) {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file
  ])
  return JSON.parse(out)
}

async function main () {
  // pure functions first
  assert.equal(normalizeFormat('MP3'), 'mp3')
  assert.equal(normalizeFormat('original'), 'original')
  assert.equal(normalizeFormat('../../etc/passwd'), 'original', 'unknown format must fall back, not pass through')
  assert.equal(normalizeFormat(undefined), 'original')
  // formats we deliberately stopped offering must not sneak back in via the API
  for (const dropped of ['flac', 'wav', 'm4a', 'opus']) {
    assert.equal(normalizeFormat(dropped), 'original', `${dropped} is no longer a conversion target`)
  }
  assert.equal(normalizeQuality('128'), '128K')
  assert.equal(normalizeQuality('best'), '0')

  // progress parsing: the bar is only as honest as this regex
  assert.equal(parseProgress('[download]  45.2% of ~3.50MiB at 1.20MiB/s ETA 00:02'), 45.2)
  assert.equal(parseProgress('[download]   0.0% of 3.50MiB'), 0)
  assert.equal(parseProgress('[download] 100% of 3.50MiB in 00:03'), 100)
  // several updates in one chunk — the newest wins
  assert.equal(parseProgress('[download]  10.0% of 1MiB\n[download]  72.5% of 1MiB\n'), 72.5)
  assert.equal(parseProgress('[ExtractAudio] Destination: song.mp3'), null)
  assert.equal(parseProgress(''), null)

  // the flags the progress stream depends on must survive dargs
  const flags = ytdl.args({ newline: true, progress: true, extractAudio: true, audioFormat: 'mp3' })
  assert.ok(flags.includes('--newline'), `--newline missing from ${flags}`)
  assert.ok(flags.includes('--progress'), `--progress missing from ${flags}`)
  assert.ok(flags.includes('--extract-audio'), `--extract-audio missing from ${flags}`)

  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR)

  // one shared 300x300 cover
  const cover = `${DIR}/cover.jpg`
  execFileSync('ffmpeg', ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=red:s=300x300', '-frames:v', '1', cover])

  for (const format of Object.keys(FORMATS)) {
    const file = `${DIR}/song.${format}`
    execFileSync('ffmpeg', ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', file])

    // no format arg — the tagger reads the container off the extension
    await applyMetadataAndCover(file, cover, META)

    const probe = ffprobe(file)
    // ogg/opus keeps its comments on the stream; the rest tag at container level
    const audio = probe.streams.find((s) => s.codec_type === 'audio') || {}
    const tags = Object.fromEntries(
      Object.entries({ ...audio.tags, ...probe.format.tags })
        .map(([k, v]) => [k.toLowerCase(), v])
    )
    const hasVideo = probe.streams.some((s) => s.codec_type === 'video')

    // wav's INFO chunk has no genre/album field, so only assert what every container holds
    assert.equal(tags.title, META.title, `${format}: title tag missing`)
    assert.equal(tags.artist, META.artist, `${format}: artist tag missing`)
    assert.equal(hasVideo, FORMATS[format].cover, `${format}: cover art expected ${FORMATS[format].cover}`)
    assert.ok(fs.statSync(file).size > 0, `${format}: file is empty`)

    console.log(`ok  ${format.padEnd(4)} tags=${tags.title}/${tags.artist} cover=${hasVideo}`)
  }

  fs.rmSync(DIR, { recursive: true, force: true })
  console.log('\nall formats pass')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
