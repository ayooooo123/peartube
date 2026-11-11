// Debrid/CDN links serve a 60 GB MKV from an opaque path (`/dld/<uuid>`) as
// `application/octet-stream`; the release name lives only in `?filename=` or
// `content-disposition`. Reading the path alone called every such film a
// webpage and asked for ubit. An HTML reply that merely names an `.mkv` in its
// query must still be treated as a page — that is the edge this pins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { identify } from '../src/identify.js'

const ENCODED = 'Dune-%20Part%20Two%20(2024)%202160p%20REMUX.mkv'
const NAME = 'Dune- Part Two (2024) 2160p REMUX.mkv'

async function withServer (handler, run) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('an opaque debrid path is a file when the name is in the query or headers', { timeout: 30_000 }, async () => {
  const handler = (req, res) => {
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '13' })
      return res.end('<html></html>')
    }
    const headers = { 'content-type': 'application/octet-stream', 'content-length': '1234567' }
    if (req.url.startsWith('/disposition')) headers['content-disposition'] = `attachment; filename="${NAME}"`
    res.writeHead(200, headers)
    res.end()
  }

  await withServer(handler, async base => {
    const queried = await identify(`${base}/dld/uuid?filename=${ENCODED}`, { cinemetaUrl: '' })
    assert.equal(queried.link.kind, 'file')
    assert.equal(queried.link.name, NAME)
    assert.equal(queried.parsed.year, 2024)

    const disposed = await identify(`${base}/disposition/uuid`, { cinemetaUrl: '' })
    assert.equal(disposed.link.kind, 'file')
    assert.equal(disposed.link.name, NAME)

    // A page that happens to name a media file in its query stays a page: without
    // ubit installed this rejects instead of importing an HTML body as the film.
    const page = await identify(`${base}/page?filename=${ENCODED}`, { cinemetaUrl: '' }).then(r => r.link.kind, () => 'rejected')
    assert.notEqual(page, 'file')
  })
})

// Debrid edges write the release name unquoted about as often as quoted, and some
// paths carry a stray `%` that is not percent-encoded text at all. Neither may
// stop a link whose reply is plainly the film from being read as one.
test('an unquoted disposition name and a stray percent in the path are still files', { timeout: 30_000 }, async () => {
  const handler = (req, res) => {
    if (req.url.startsWith('/unquoted')) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1234567',
        'content-disposition': 'attachment; filename=Dune.Part.Two.2024.2160p.mkv'
      })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': '1234567' })
    res.end()
  }

  await withServer(handler, async base => {
    const unquoted = await identify(`${base}/unquoted/uuid`, { cinemetaUrl: '' })
    assert.equal(unquoted.link.kind, 'file')
    assert.equal(unquoted.link.name, 'Dune.Part.Two.2024.2160p.mkv')
    assert.equal(unquoted.parsed.title, 'Dune Part Two')
    assert.equal(unquoted.parsed.year, 2024)

    // `decodeURIComponent('100%')` throws; the link itself is fine.
    const stray = await identify(`${base}/dl/100%`, { cinemetaUrl: '' })
    assert.equal(stray.link.kind, 'file')
    assert.equal(stray.link.name, '100%')

    // The same path with the release name in the query: the stray escape must not shadow it.
    const queried = await identify(`${base}/dl/100%?filename=${ENCODED}`, { cinemetaUrl: '' })
    assert.equal(queried.link.kind, 'file')
    assert.equal(queried.link.name, NAME)
  })
})
