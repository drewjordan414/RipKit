import { useEffect, useRef, useState } from 'react'

// Higher bitrates than the source cannot add back what the source never had —
// they only make the file bigger. VBR lets the encoder track the material; the
// lower rates are here for when you want the space back and accept the cost.
const QUALITIES = [
  { value: '0', label: 'Best', note: 'Variable bitrate, around 245k. Tracks the material instead of padding quiet passages.' },
  { value: '192', label: '192k', note: 'Smaller files, a little quality given up on dense material.' },
  { value: '128', label: '128k', note: 'Smallest. Audibly lossy — pick this only when space matters more than sound.' }
]

const FORMATS = [
  { value: 'original', label: 'ORIGINAL', note: 'No re-encode. Keeps the source stream exactly as it arrived — usually Opus or AAC. Nothing here can beat it for quality.' },
  { value: 'mp3', label: 'MP3', note: 'Re-encodes, so it loses a little. Worth it only if your player cannot read Opus or AAC — old iPods, car stereos, cheap DAPs.' }
]

const DESTINATIONS = [
  { value: 'zip', label: 'ZIP DOWNLOAD' },
  { value: 'archive', label: 'ZIP ON SERVER' },
  { value: 'save', label: 'SAVE TO FOLDER' }
]

// bitrate only means something when we are actually re-encoding
const BITRATE_OK = ['mp3']

const STATUS_MARK = { done: '✓', failed: '✕', skipped: '–', stopped: '–' }

// how many rows land at a time
const PAGE = 25

// No request may sit open forever holding one of the browser's few
// per-origin connections — progress is what the user is watching.
const POLL_TIMEOUT = 5000
const ART_TIMEOUT = 12000

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

// What a finished rip left behind. Each delivery mode ends somewhere
// different, so each one says where.
function Outcome ({ result, stopped, zipName }) {
  const lead = stopped ? 'Stopped. ' : ''
  const n = result.files
  const plural = (one, many) => `${n} ${n === 1 ? one : many}`

  if (result.saved) {
    return (
      <span>
        {stopped ? 'Stopped. Kept ' : 'Saved '}
        {plural('file', 'files')} in <code>{result.saved}</code>
      </span>
    )
  }

  if (result.archive) {
    const mb = result.bytes ? ` (${(result.bytes / 1048576).toFixed(1)} MB)` : ''
    return (
      <span>
        {lead}Wrote {plural('track', 'tracks')}{mb} to <code>{result.archive}</code>
      </span>
    )
  }

  if (!n) return <span>Nothing came back — every row failed or was skipped.</span>

  return (
    <>
      <span>{lead}{plural('file is', 'files are')} ready.</span>
      <a className='saved__get' href={result.download} download={`${zipName}.zip`}>
        Download {zipName}.zip
      </a>
    </>
  )
}

export default function App () {
  const [file, setFile] = useState(null)
  const [tracks, setTracks] = useState([])
  const [quality, setQuality] = useState('0')
  const [format, setFormat] = useState('original')
  // the rip as the server sees it — this page watches it, it does not own it
  const [job, setJob] = useState(null)
  const [starting, setStarting] = useState(false)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [deliver, setDeliver] = useState('zip')
  const [folder, setFolder] = useState('')
  const [root, setRoot] = useState('')
  const [zipRoot, setZipRoot] = useState('')
  const [sep, setSep] = useState('/')
  const [error, setError] = useState('')
  const [shownDone, setShownDone] = useState(PAGE)
  const [shownQueue, setShownQueue] = useState(PAGE)
  const inputRef = useRef(null)
  const artAsked = useRef(new Set())
  // only auto-save the ZIP for the rip this tab kicked off; a reloaded page
  // gets a button instead, because a download nobody clicked for is a surprise
  const startedHere = useRef(null)
  const grabbed = useRef(null)
  // latches keeping each kind of request to one in flight — see the art effect
  const artBusy = useRef(false)
  const pollBusy = useRef(false)
  const [artTick, setArtTick] = useState(0)

  const busy = starting || job?.status === 'running'
  const result = job && job.status !== 'running' ? job.result : null
  const zipName = folder.trim() || 'songs'
  const noBitrate = !BITRATE_OK.includes(format)

  const indexed = tracks.map((track, index) => ({ track, index }))
  const activeIdx = tracks.findIndex((t) => t.status === 'working')
  const active = activeIdx >= 0 ? tracks[activeIdx] : null
  // newest first, so a finished track lands directly under the one ripping
  const finished = indexed.filter(({ track }) => track.status === 'done' || track.status === 'failed').reverse()
  const queued = indexed.filter(({ track }) =>
    ['queued', 'skipped', 'stopped'].includes(track.status))

  const done = tracks.filter((t) => t.status === 'done').length
  const failed = tracks.filter((t) => t.status === 'failed' || t.status === 'skipped').length

  // One poll in flight at a time. A slow response must delay the next tick,
  // never stack up behind it.
  const syncProgress = async () => {
    if (pollBusy.current) return
    pollBusy.current = true
    try {
      const res = await fetch('/progress', { signal: AbortSignal.timeout(POLL_TIMEOUT) })
      if (!res.ok) return
      const data = await res.json()

      if (data.job) {
        setJob(data.job)
        if (data.job.status !== 'running') setStopping(false)
      }

      const moved = Object.entries(data.tracks || {})
      if (!moved.length) return
      // the server sends only rows that changed; everything else we already have
      setTracks((prev) => {
        const next = [...prev]
        for (const [i, patch] of moved) next[i] = { ...next[i], ...patch }
        return next
      })
    } catch { /* server is mid-rip; the next tick retries */ } finally {
      pollBusy.current = false
    }
  }

  // A rip lives on the server, not in this tab. On load, ask whether one is
  // already going and pick it back up — reloading mid-rip should cost you the
  // scroll position and nothing else.
  useEffect(() => {
    fetch('/destination')
      .then((r) => r.json())
      .then((d) => { setRoot(d.root); setZipRoot(d.zipRoot); setSep(d.separator) })
      .catch(() => {})

    fetch('/job')
      .then((r) => r.json())
      .then((data) => {
        if (!data.job) return
        setJob(data.job)
        setTracks(data.tracks)
        setFormat(data.job.format)
        setQuality(data.job.quality)
        setDeliver(data.job.deliver)
        setFolder(data.job.folder)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!busy) return
    const id = setInterval(syncProgress, 700)
    return () => clearInterval(id)
  }, [busy])

  // ZIP mode: the rip this tab started saves itself the moment it is ready.
  useEffect(() => {
    if (!result?.download || !result.files) return
    if (grabbed.current === job.id || job.id !== startedHere.current) return
    grabbed.current = job.id

    const a = document.createElement('a')
    a.href = result.download
    a.download = `${zipName}.zip`
    a.click()
  }, [result, job, zipName])

  // Cover art for the rows on screen, a page at a time. Fetching art for the
  // whole CSV up front does not survive a 17k-row library export.
  //
  // Strictly one request at a time. This effect re-runs on every progress
  // tick, and each finished track scrolls a fresh row into view — so without
  // a latch it fires a new /art on every tick. iTunes throttles at around 20
  // calls a minute, the throttled ones hang, and a browser only gives an
  // origin ~6 connections. They fill up, /progress queues behind them, and
  // the page looks frozen until you reload. Artwork must never outrank the
  // progress the user is actually watching.
  useEffect(() => {
    if (artBusy.current) return

    const visible = [
      ...(active ? [{ track: active, index: activeIdx }] : []),
      ...finished.slice(0, shownDone),
      ...queued.slice(0, shownQueue)
    ]

    const need = visible.filter(({ track, index }) =>
      track && track.art === undefined && track.title && track.artist &&
      !artAsked.current.has(index)
    ).slice(0, 60)

    if (!need.length) return
    need.forEach(({ index }) => artAsked.current.add(index))
    artBusy.current = true

    ;(async () => {
      try {
        const res = await fetch('/art', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tracks: need.map(({ track, index }) => ({
              index, title: track.title, artist: track.artist
            }))
          }),
          signal: AbortSignal.timeout(ART_TIMEOUT)
        })
        const { art } = await res.json()
        setTracks((prev) => {
          const next = [...prev]
          for (const [i, url] of Object.entries(art)) next[i] = { ...next[i], art: url }
          return next
        })
      } catch {
        // let a later render retry these
        need.forEach(({ index }) => artAsked.current.delete(index))
      } finally {
        artBusy.current = false
        // the rip may already be finished, so nothing else would re-run this
        setArtTick((t) => t + 1)
      }
    })()
  }, [tracks, shownDone, shownQueue, activeIdx, artTick])

  const pick = async (f) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError(`${f.name} is not a CSV. Export your playlist as CSV and try again.`)
      return
    }

    setError('')
    setFile(f)
    setJob(null) // a new CSV means the last rip's result banner is stale
    setFolder((prev) => prev || f.name.replace(/\.csv$/i, ''))
    setTracks([])
    setShownDone(PAGE)
    setShownQueue(PAGE)
    artAsked.current = new Set()
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

  // Kick the rip off and step back. The request returns as soon as the server
  // has the job, so nothing about this page's lifetime is holding it up.
  const rip = async () => {
    if (!file || busy) return
    setStarting(true)
    setStopping(false)
    setJob(null)
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
    body.append('deliver', deliver)
    body.append('folder', folder)

    try {
      const res = await fetch('/upload', { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`)
      startedHere.current = data.job.id
      setJob(data.job)
    } catch (err) {
      setError(`Rip failed: ${err.message}. Check the terminal running the server.`)
    } finally {
      setStarting(false)
    }
  }

  // Stop the rip. The server kills the running download and still packages
  // whatever finished, so a stop is never a total loss.
  const stop = async () => {
    setStopping(true)
    try {
      await fetch('/cancel', { method: 'POST' })
      await syncProgress()
    } catch {
      setError('Could not reach the server to stop the rip.')
      setStopping(false)
    }
  }

  // Clear the finished job on the server too, or it comes straight back on the
  // next reload.
  const reset = async () => {
    setFile(null)
    setTracks([])
    setJob(null)
    setFolder('')
    setShownDone(PAGE)
    setShownQueue(PAGE)
    artAsked.current = new Set()
    setError('')
    if (inputRef.current) inputRef.current.value = ''
    await fetch('/job', { method: 'DELETE' }).catch(() => {})
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
              <span className='counts__stat'>
                <b>{tracks.length}</b> tracks
              </span>
              {done > 0 && (
                <span className='counts__stat is-done'><b>{done}</b> done</span>
              )}
              {failed > 0 && (
                <span className='counts__stat is-failed'><b>{failed}</b> skipped</span>
              )}
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

      {job?.status === 'failed' && <p className='error'>Rip failed: {job.error}</p>}

      {result && (
        <div className='saved'>
          <Outcome result={result} stopped={job.status === 'stopped'} zipName={zipName} />
        </div>
      )}

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

            <fieldset className='pills' disabled={busy}>
              <legend>Where it goes</legend>
              <div className='pills__row'>
                {DESTINATIONS.map((d) => (
                  <button
                    key={d.value}
                    type='button'
                    className={deliver === d.value ? 'is-on' : ''}
                    aria-pressed={deliver === d.value}
                    onClick={() => setDeliver(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              {/* One folder name, both destinations: it names the folder on
                  disk when saving, and the folder inside the archive when
                  zipping — so a ZIP unpacks into something, not everywhere. */}
              <div className='dest'>
                <input
                  className='dest__input'
                  value={folder}
                  placeholder={deliver === 'save' ? 'folder name' : 'songs'}
                  aria-label='Folder name'
                  disabled={busy}
                  onChange={(e) => setFolder(e.target.value)}
                />
                {deliver === 'save' && (
                  <p className='dest__path'>
                    {root
                      ? <>Files land in <code>{root}{folder ? sep + folder : ''}</code></>
                      : 'Reading the server download folder…'}
                  </p>
                )}

                {deliver === 'archive' && (
                  <p className='dest__path'>
                    {zipRoot
                      ? <>The archive is written to <code>{zipRoot}{sep}{zipName}.zip</code> on
                        the machine running the server. Nothing is sent to your browser, so
                        you can close the tab.</>
                      : 'Reading the server output folder…'}
                  </p>
                )}

                {deliver === 'zip' && (
                  <p className='dest__path'>
                    Your browser downloads <code>{zipName}.zip</code>, which unpacks
                    into a <code>{zipName}</code> folder. The server holds it until you
                    rip again or start over, so a reload cannot lose it.
                  </p>
                )}
              </div>
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
              <p className='pills__note'>
                {noBitrate
                  ? 'Nothing gets re-encoded, so there is no bitrate to set.'
                  : QUALITIES.find((q) => q.value === quality).note}
              </p>
            </fieldset>

            {busy
              ? (
                <button className='go go--stop' onClick={stop} disabled={stopping}>
                  {stopping ? 'Stopping…' : 'Stop ripping'}
                </button>
                )
              : (
                // after a reload the tracklist comes back from the server but
                // the CSV does not — the file input is the browser's to give
                <button className='go' onClick={rip} disabled={!file}>
                  {!file
                    ? 'Drop the CSV again to rip'
                    : format === 'original'
                      ? 'Rip at source quality'
                      : `Rip to ${format.toUpperCase()}`}
                </button>
                )}
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
        <a href='https://github.com/drewjordan414/RipKit' target='_blank' rel='noopener noreferrer'>Source</a>
        <span>Download only what you have the right to.</span>
      </footer>
    </main>
  )
}
