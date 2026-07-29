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

function Wheel ({ done, total, busy }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className='wheel' style={{ '--pct': pct }} role='img'
      aria-label={total ? `${done} of ${total} songs done` : 'No job running'}>
      <span className='wheel__label wheel__label--top'>MENU</span>
      <span className='wheel__label wheel__label--left'>◀◀</span>
      <span className='wheel__label wheel__label--right'>▶▶</span>
      <span className='wheel__label wheel__label--bottom'>▶ ❙❙</span>
      <div className='wheel__hub'>
        {total
          ? <><b>{done}</b><i>of {total}</i></>
          : <b className='wheel__idle'>{busy ? '···' : '0'}</b>}
      </div>
    </div>
  )
}

export default function App () {
  const [file, setFile] = useState(null)
  const [quality, setQuality] = useState('0')
  const [format, setFormat] = useState('mp3')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '', detail: '' })
  const [log, setLog] = useState([])
  const logRef = useRef(null)
  const inputRef = useRef(null)

  const say = (line) => setLog((l) => [...l, line])
  const noBitrate = !BITRATE_OK.includes(format)

  useEffect(() => {
    if (!busy) return
    const id = setInterval(async () => {
      try {
        const res = await fetch('/progress')
        if (res.ok) setProgress(await res.json())
      } catch { /* server busy mid-rip; next tick retries */ }
    }, 1000)
    return () => clearInterval(id)
  }, [busy])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const pick = (f) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.csv')) {
      say(`${f.name} is not a CSV. Export your playlist as CSV and try again.`)
      return
    }
    setFile(f)
    say(`Loaded ${f.name}`)
  }

  const rip = async () => {
    if (!file || busy) return
    setBusy(true)
    setProgress({ done: 0, total: 0, current: '' })
    say('Uploading CSV…')

    const body = new FormData()
    body.append('csv', file)
    body.append('quality', quality)
    body.append('format', format)

    try {
      const res = await fetch('/upload', { method: 'POST', body })
      if (!res.ok) throw new Error(`server responded ${res.status}`)

      say('Zipping…')
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = 'songs.zip'
      a.click()
      URL.revokeObjectURL(url)
      say('songs.zip is in your downloads.')
    } catch (err) {
      say(`Rip failed: ${err.message}. Check the terminal running the server.`)
    } finally {
      setBusy(false)
      setProgress((p) => ({ ...p, current: '' }))
    }
  }

  return (
    <main className='page'>
      <header className='masthead'>
        <div className='mark'>RIP KIT</div>
        <div className='tag'>rip · tag · own</div>
      </header>

      <section className='deck'>
        <h1>Your playlist, as files you keep.</h1>
        <p>
          Feed it a playlist export. It finds each track, pulls the audio, embeds
          album art and tags, and hands back a ZIP of files any player reads —
          including the one in your drawer.
        </p>
      </section>

      <section className='device'>
        <div className='device__wheel'>
          <Wheel done={progress.done} total={progress.total} busy={busy} />
          <div className='nowplaying'>
            <span className='nowplaying__song'>
              {busy ? (progress.current || 'Starting up…') : 'Idle'}
            </span>
            {busy && progress.detail && (
              <span className='nowplaying__detail'>{progress.detail}</span>
            )}
          </div>
        </div>

        <div className='device__controls'>
          <label
            className={`drop${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
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
              onChange={(e) => pick(e.target.files[0])}
            />
            <span className='drop__name'>{file ? file.name : 'Drop a CSV here'}</span>
            <span className='drop__hint'>{file ? 'Click to swap' : 'or click to browse'}</span>
          </label>

          <fieldset className='pills'>
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

          <fieldset className='pills' disabled={noBitrate}>
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

          <button className='go' onClick={rip} disabled={!file || busy}>
            {busy
              ? 'Ripping…'
              : format === 'original' ? 'Rip at source quality' : `Rip to ${format.toUpperCase()}`}
          </button>
        </div>
      </section>

      <section className='console'>
        <div className='console__head'>Activity</div>
        <div className='console__body' ref={logRef}>
          {log.length === 0
            ? <p className='console__empty'>Nothing yet. Pick a CSV to start.</p>
            : log.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      </section>

      <section className='steps'>
        <ol>
          <li>
            <span className='steps__n'>1</span>
            <p>
              Export a playlist to CSV — <a href='https://www.chosic.com/spotify-playlist-exporter/' target='_blank' rel='noopener noreferrer'>Chosic</a> does it for Spotify.
              Any file with title and artist columns works.
            </p>
          </li>
          <li>
            <span className='steps__n'>2</span>
            <p>Drop it above, pick a bitrate, hit rip.</p>
          </li>
          <li>
            <span className='steps__n'>3</span>
            <p>Unzip. Drag into your library. Sync.</p>
          </li>
        </ol>
      </section>

      <footer>
        <a href='https://github.com/drewjordan414/csv-music-downloader' target='_blank' rel='noopener noreferrer'>Source</a>
        <span>Download only what you have the right to.</span>
      </footer>
    </main>
  )
}
