// Checks that a rip belongs to the server, not to the page that started it.
// Every row here is missing a title, so each job completes on the "skipped"
// path — the whole lifecycle is exercised without a single download.
// Run: node test-job.js   (no ffmpeg, no network)

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PORT = process.env.TEST_PORT || 3199
const BASE = `http://localhost:${PORT}`
const DIR = path.resolve('test_tmp')
const CSV = 'album,year\nSome Record,1999\nAnother Record,2001\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function start (folder, deliver) {
  const body = new FormData()
  body.append('csv', new Blob([CSV], { type: 'text/csv' }), 'rows.csv')
  body.append('format', 'mp3')
  body.append('deliver', deliver)
  body.append('folder', folder)
  return fetch(`${BASE}/upload`, { method: 'POST', body })
}

async function settled () {
  for (let i = 0; i < 100; i++) {
    const { job } = await (await fetch(`${BASE}/progress`)).json()
    if (job && job.status !== 'running') return job
    await sleep(100)
  }
  throw new Error('job never reached a terminal state')
}

async function main () {
  fs.rmSync(DIR, { recursive: true, force: true })

  const server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DOWNLOAD_DIR: path.join(DIR, 'downloads'),
      STAGE_DIR: path.join(DIR, 'staging'),
      ZIP_DIR: path.join(DIR, 'out')
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })

  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${BASE}/destination`); break } catch { await sleep(100) }
    }

    assert.equal((await (await fetch(`${BASE}/job`)).json()).job, null,
      'a fresh server must report no job')

    // ── the rip outlives the request that started it ────────────────────
    const res = await start('My Mix', 'zip')
    assert.equal(res.status, 202,
      '/upload must return as soon as the job is registered, not when the rip ends')
    const begun = (await res.json()).job
    assert.equal(begun.status, 'running')
    assert.equal(begun.folder, 'My Mix')

    // This is a request from a client that knows nothing — i.e. a reloaded
    // page. It has to be able to find the rip and redraw it.
    const found = await (await fetch(`${BASE}/job`)).json()
    assert.equal(found.job.id, begun.id, 'a reloaded page must find the running job')
    assert.equal(found.tracks.length, 2, 'the tracklist must survive the reload')
    assert.equal(found.tracks[0].album, 'Some Record',
      'rehydration needs track metadata, not just status')

    // one rip at a time: a stray second upload must not trample the first
    if (begun.status === 'running') {
      const clash = await start('Interloper', 'zip')
      assert.ok([202, 409].includes(clash.status))
    }

    const zipJob = await settled()
    assert.ok(zipJob.result.download.startsWith('/download/'),
      'zip mode hands back a link instead of a stream')

    // ── the archive is still there afterwards ───────────────────────────
    const zip = await fetch(`${BASE}${zipJob.result.download}`)
    assert.equal(zip.status, 200, 'a finished archive must still be fetchable')
    assert.match(zip.headers.get('content-disposition'), /filename="[^"]+\.zip"/)
    assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK',
      'that is not a zip')
    assert.equal((await fetch(`${BASE}${zipJob.result.download}`)).status, 200,
      'fetching twice must work — reloading after a download is not a mistake')

    // ── the folder name reaches both destinations ───────────────────────
    const named = await (await start('Road Trip', 'zip')).json()
    await settled()
    const disp = (await fetch(`${BASE}${named.job.result?.download || `/download/${named.job.id}`}`))
      .headers.get('content-disposition')
    assert.match(disp, /filename="Road Trip\.zip"/, 'the folder name must name the archive')

    // ── ZIP on server: the archive lands on this machine, not in a browser ─
    await start('Server Drop', 'archive')
    const arc = await settled()
    assert.equal(arc.deliver, 'archive')
    assert.ok(arc.result.archive.endsWith(path.join('out', 'Server Drop.zip')),
      `archive went to the wrong place: ${arc.result.archive}`)
    assert.ok(fs.existsSync(arc.result.archive), 'the archive must exist on disk')
    assert.equal(fs.readFileSync(arc.result.archive).subarray(0, 2).toString(), 'PK',
      'the file on disk is not a zip')
    assert.ok(arc.result.bytes > 0, 'the archive should report its size')
    // staging is scratch: packing it is the whole job, so it must not linger
    assert.ok(!fs.existsSync(path.join(DIR, 'staging', arc.id)),
      'the staging folder should be gone once the archive is written')

    await start('Kept Folder', 'save')
    const saveJob = await settled()
    assert.equal(saveJob.deliver, 'save')
    assert.ok(saveJob.result.saved.endsWith(path.join('downloads', 'Kept Folder')),
      `save mode wrote to the wrong place: ${saveJob.result.saved}`)
    assert.ok(fs.existsSync(saveJob.result.saved), 'save mode must create the named folder')

    // a name is a name, never a path — same rule as resolveDest
    await start('../escape', 'save')
    const escaped = await settled()
    assert.ok(escaped.result.saved.includes(path.join('downloads', 'escape')),
      `traversal reached the filesystem: ${escaped.result.saved}`)

    // ── "start over" has to clear the server, or it comes back on reload ─
    assert.equal((await fetch(`${BASE}/job`, { method: 'DELETE' })).status, 200)
    assert.equal((await (await fetch(`${BASE}/job`)).json()).job, null,
      'a cleared job must not come back')

    console.log('job lifecycle: all checks pass')
  } finally {
    server.kill('SIGTERM')
    fs.rmSync(DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
