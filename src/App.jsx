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

// how many rows land at a time
const PAGE = 25

function Cover ({ art, className = '' }) {
  return art
    ? <img className={className} src={art} alt='' loading='lazy' />
    : <span className={`${className} cover--empty`} aria-hidden='true' />
}

// The track being worked on right now: full-size art with the bar across it.
function NowRipping ({ track, position, total }) {
  const { title, artist, album, year, art, detail, percent = 0 } = track

  return (
    <section className='now'>
      <div className='now__art'>
        <Cover art={art} className='now__img' />
        <div
          className='now__bar'
          role='progressbar'
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className='now__text'>
        <span className='now__eyebrow'>Ripping {position} of {total}</span>
        <h2 className='now__title'>{title}</h2>
        <span className='now__artist'>{artist}</span>
        <span className='now__album'>{[album, year].filter(Boolean).join(' · ')}</span>
      </div>

      <div className='now__readout'>
        <span className='now__pct'>{percent}<i>%</i></span>
        <span className='now__phase'>{detail}</span>
      </div>
    </section>
  )
}

function Track ({ track, index, order }) {
  const { title, artist, album, year, art, status, detail } = track
  const meta = [album, year].filter(Boolean).join(' · ')

  return (
    <li className={`track is-${status}`} style={{ '--i': order % PAGE }}>
      <div className='track__art'>
        <Cover art={art} className='track__img' />
      </div>

      <span className='track__n'>{String(index + 1).padStart(2, '0')}</span>

      <div className='track__names'>
        <span className='track__title'>{title || 'Unreadable row'}</span>
        <span className='track__artist'>{artist || '—'}</span>
      </div>

      <div className='track__meta'>
        {detail
          ? <span className='track__detail'>{detail}</span>
          : <span className='track__album'>{meta}</span>}
      </div>

      <span className='track__status' title={status}>
        {STATUS_MARK[status] || '·'}
      </span>
    </li>
  )
}

function Stack ({ items, shown, onMore, label, count }) {
  const remaining = items.length - shown
  return (
    <>
      {label && (
        <h3 className='stack__head'>
          {label}<span>{count ?? items.length}</span>
        </h3>
      )}
      <ol className='tracklist'>
        {items.slice(0, shown).map(({ track, index }, order) => (
          <Track key={index} track={track} index={index} order={order} />
        ))}
      </ol>
      {remaining > 0 && (
        <button className='more' onClick={onMore}>
          See {Math.min(PAGE, remaining)} more
          <span className='more__count'>{remaining} left</span>
        </button>
      )}
    </>
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
  const [shownDone, setShownDone] = useState(PAGE)
  const [shownQueue, setShownQueue] = useState(PAGE)
  const inputRef = useRef(null)

  const noBitrate = !BITRATE_OK.includes(format)

  const indexed = tracks.map((track, index) => ({ track, index }))
  const activeIdx = tracks.findIndex((t) => t.status === 'working')
  const active = activeIdx >= 0 ? tracks[activeIdx] : null
  // newest first, so a finished track lands directly under the one ripping
  const finished = indexed.filter(({ track }) => track.status === 'done' || track.status === 'failed').reverse()
  const queued = indexed.filter(({ track }) => track.status === 'queued' || track.status === 'skipped')

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
    }, 700)
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
    setShownDone(PAGE)
    setShownQueue(PAGE)
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
    setShownDone(PAGE)
    setShownQueue(PAGE)
    setTracks((prev) => prev.map((t) => (
      t.status === 'skipped' ? t : { ...t, status: 'queued', detail: '', percent: 0 }
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
    setShownDone(PAGE)
    setShownQueue(PAGE)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const loaded = tracks.length > 0
  const started = busy || finished.length > 0

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
            <fieldset className='pills' disabled={busy}>
              <legend>Format</legend>
              <div className='pills__row'>
                {FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type='button'
                    className={format === f.value ? 'is-on' : ''}
                    aria-pressed={format === f.value}
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
                ? `Ripping ${done + failed + 1} of ${tracks.length}…`
                : format === 'original'
                  ? 'Rip at source quality'
                  : `Rip to ${format.toUpperCase()}`}
            </button>
          </section>

          {active && (
            <NowRipping
              track={active}
              position={activeIdx + 1}
              total={tracks.length}
            />
          )}

          {finished.length > 0 && (
            <Stack
              items={finished}
              shown={shownDone}
              onMore={() => setShownDone((s) => s + PAGE)}
              label='Finished'
              count={finished.length}
            />
          )}

          {queued.length > 0 && (
            <Stack
              items={queued}
              shown={shownQueue}
              onMore={() => setShownQueue((s) => s + PAGE)}
              label={started ? 'Up next' : null}
              count={queued.length}
            />
          )}
        </>
      )}

      <footer>
        <a href='https://github.com/drewjordan414/csv-music-downloader' target='_blank' rel='noopener noreferrer'>Source</a>
        <span>Download only what you have the right to.</span>
      </footer>
    </main>
  )
}
