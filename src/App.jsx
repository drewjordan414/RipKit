import { useEffect, useRef, useState } from 'react'

const QUALITIES = [
  { value: '0', label: 'Best' },
  { value: '128', label: '128k' },
  { value: '192', label: '192k' },
  { value: '256', label: '256k' },
  { value: '320', label: '320k' }
]

const FORMATS = [
  { value: 'original', label: 'ORIGINAL', note: 'No re-encode. Keeps the source stream exactly as it came — the best quality available, usually Opus or AAC.' },
  { value: 'mp3', label: 'MP3', note: 'Plays on everything. Keeps album art.' },
  { value: 'm4a', label: 'M4A', note: 'Apple-native AAC. Often copied straight from the source, no second re-encode.' },
  { value: 'flac', label: 'FLAC', note: 'Lossless container around an already-compressed source. Bigger files, no quality gained.' },
  { value: 'wav', label: 'WAV', note: 'Uncompressed. No album art — the format cannot hold one.' },
  { value: 'opus', label: 'OPUS', note: 'Smallest at good quality. No album art. Newer players only.' }
]

// bitrate only means something when we are actually re-encoding to a lossy codec
const BITRATE_OK = ['mp3', 'm4a', 'opus']

const STATUS_MARK = { done: '✓', failed: '✕', skipped: '–' }

function Track ({ track, index }) {
  const { title, artist, album, year, art, status, detail } = track
  const meta = [album, year].filter(Boolean).join(' · ')

  return (
    <li className={`track is-${status}`}>
      <div className='track__art'>
        {art
          ? <img src={art} alt='' loading='lazy' />
          : <span className='track__art--empty' aria-hidden='true' />}
      </div>

      <span className='track__n'>{String(index + 1).padStart(2, '0')}</span>

      <div className='track__names'>
        <span className='track__title'>{title || 'Unreadable row'}</span>
        <span className='track__artist'>{artist || '—'}</span>
      </div>

      <div className='track__meta'>
        {status === 'working' || status === 'failed' || (status === 'done' && detail)
          ? <span className='track__detail'>{detail}</span>
          : <span className='track__album'>{meta}</span>}
      </div>

      <span className='track__status' title={status}>
        {status === 'working'
          ? <span className='track__spinner' aria-label='working' />
          : (STATUS_MARK[status] || '·')}
      </span>
    </li>
  )
}

export default function App () {
  const [file, setFile] = useState(null)
  const [tracks, setTracks] = useState([])
  const [quality, setQuality] = useState('0')
  const [format, setFormat] = useState('mp3')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const noBitrate = !BITRATE_OK.includes(format)
  const done = tracks.filter((t) => t.status === 'done').length
  const failed = tracks.filter((t) => t.status === 'failed' || t.status === 'skipped').length

  useEffect(() => {
    if (!busy) return
    const id = setInterval(async () => {
      try {
        const res = await fetch('/progress')
        if (!res.ok) return
        const data = await res.json()
        if (!data.tracks?.length) return
        // the server only reports status; titles and art stay client-side
        setTracks((prev) => prev.map((t, i) => ({ ...t, ...(data.tracks[i] || {}) })))
      } catch { /* server is mid-rip; next tick retries */ }
    }, 1000)
    return () => clearInterval(id)
  }, [busy])

  const pick = async (f) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError(`${f.name} is not a CSV. Export your playlist as CSV and try again.`)
      return
    }

    setError('')
    setFile(f)
    setTracks([])
    setReading(true)

    try {
      const body = new FormData()
      body.append('csv', f)
      const res = await fetch('/preview', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not read that CSV.')
      if (!data.tracks.length) throw new Error('That CSV has no rows.')
      setTracks(data.tracks)
    } catch (err) {
      setError(err.message)
      setFile(null)
    } finally {
      setReading(false)
    }
  }

  const rip = async () => {
    if (!file || busy) return
    setBusy(true)
    setError('')
    setTracks((prev) => prev.map((t) => (
      t.status === 'skipped' ? t : { ...t, status: 'queued', detail: '' }
    )))

    const body = new FormData()
    body.append('csv', file)
    body.append('quality', quality)
    body.append('format', format)

    try {
      const res = await fetch('/upload', { method: 'POST', body })
      if (!res.ok) throw new Error(`server responded ${res.status}`)

      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = 'songs.zip'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(`Rip failed: ${err.message}. Check the terminal running the server.`)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setFile(null)
    setTracks([])
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const loaded = tracks.length > 0

  return (
    <main className={`page${loaded ? ' is-loaded' : ''}`}>
      <header className='masthead'>
        <div className='mark'>RIP KIT</div>
        {loaded
          ? (
            <div className='counts'>
              <span>{tracks.length} tracks</span>
              {done > 0 && <span className='counts__done'>{done} done</span>}
              {failed > 0 && <span className='counts__failed'>{failed} skipped</span>}
              <button className='counts__reset' onClick={reset} disabled={busy}>
                Start over
              </button>
            </div>
            )
          : <div className='tag'>rip · tag · own</div>}
      </header>

      {!loaded && (
        <section className='deck'>
          <h1>Your playlist, as files you keep.</h1>
          <p>
            Drop a playlist export. Every track gets found, pulled, tagged with its
            album art, and handed back as a ZIP any player reads — including the one
            in your drawer.
          </p>
        </section>
      )}

      <label
        className={`drop${dragging ? ' is-dragging' : ''}${loaded ? ' is-compact' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          pick(e.dataTransfer.files[0])
        }}
      >
        <input
          ref={inputRef}
          type='file'
          accept='.csv'
          disabled={busy}
          onChange={(e) => pick(e.target.files[0])}
        />
        <span className='drop__name'>
          {reading ? 'Reading…' : file ? file.name : 'Drop a playlist CSV here'}
        </span>
        <span className='drop__hint'>
          {file ? 'Click to swap' : 'or click to browse'}
        </span>
      </label>

      {error && <p className='error'>{error}</p>}

      {loaded && (
        <>
          <section className='bar'>
            <fieldset className='pills'>
              <legend>Format</legend>
              <div className='pills__row'>
                {FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type='button'
                    className={format === f.value ? 'is-on' : ''}
                    aria-pressed={format === f.value}
                    disabled={busy}
                    onClick={() => setFormat(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <p className='pills__note'>
                {FORMATS.find((f) => f.value === format).note}
              </p>
            </fieldset>

            <fieldset className='pills' disabled={noBitrate || busy}>
              <legend>Bitrate</legend>
              <div className='pills__row'>
                {QUALITIES.map((q) => (
                  <button
                    key={q.value}
                    type='button'
                    className={quality === q.value ? 'is-on' : ''}
                    aria-pressed={quality === q.value}
                    onClick={() => setQuality(q.value)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              {noBitrate && (
                <p className='pills__note'>
                  {format === 'original'
                    ? 'Nothing gets re-encoded, so there is no bitrate to set.'
                    : `${format.toUpperCase()} stores every sample, so there is no bitrate to set.`}
                </p>
              )}
            </fieldset>

            <button className='go' onClick={rip} disabled={busy}>
              {busy
                ? `Ripping ${done + 1} of ${tracks.length}…`
                : format === 'original'
                  ? 'Rip at source quality'
                  : `Rip to ${format.toUpperCase()}`}
            </button>
          </section>

          <ol className='tracklist'>
            {tracks.map((t, i) => <Track key={i} track={t} index={i} />)}
          </ol>
        </>
      )}

      <footer>
        <a href='https://github.com/drewjordan414/csv-music-downloader' target='_blank' rel='noopener noreferrer'>Source</a>
        <span>Download only what you have the right to.</span>
      </footer>
    </main>
  )
}
