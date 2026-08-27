import test from 'brittle'
import { createServer } from 'node:http'
import { fetchPosterBytes } from '../src/archive-manager.js'
import { openResponse, readBody } from '../src/media/http-get.js'

// The relay runs on Bare. Bare has no global `fetch` and no global
// `AbortController`. This suite runs on Node, which has both — which is exactly
// how a `fetch is not defined` crash shipped to a live relay with 45 test files
// green: nothing here could tell the difference between "the code does not use
// a Node-only global" and "the test happens to run somewhere that has one".
//
// So these tests take the globals away for the duration of the call. That is
// the only shape of test that would have caught the poster fetch, and the same
// shape that would have caught the earlier `AbortController is not defined`
// crash on device. Anything reaching for a global the relay's runtime does not
// have now fails here, on Node, instead of in production.
//
// run-tests.mjs gives every file its own process, so removing a global for a
// few awaits cannot reach another suite.

function withoutBareMissingGlobals (fn) {
  const saved = {
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController
  }
  delete globalThis.fetch
  delete globalThis.AbortController
  const restore = () => {
    globalThis.fetch = saved.fetch
    globalThis.AbortController = saved.AbortController
  }
  let result
  try {
    result = fn()
  } catch (err) {
    restore()
    throw err
  }
  return Promise.resolve(result).then(
    (value) => { restore(); return value },
    (err) => { restore(); throw err }
  )
}

// The exact production failure, at its smallest. The old signature was
// `{ fetchImpl = fetch }`, and a default parameter is evaluated on entry — so
// this threw ReferenceError before the body could even decide there was no
// poster to fetch. Every publish died, whatever the job carried.
test('the poster fetch does not reach for a global the relay does not have', async (t) => {
  await withoutBareMissingGlobals(async () => {
    t.is(await fetchPosterBytes(''), null, 'a job with no poster path resolves instead of throwing')
    t.is(await fetchPosterBytes(null), null, 'and so does one with none at all')
  })
})

// The replacement client itself, proven against a real socket with the globals
// gone. Without this, the tests above would also pass for an implementation
// that merely captured `fetch` at import time.
test('the vendored http client reads a response without fetch or AbortController', async (t) => {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/poster.jpg' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.byteLength) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  await withoutBareMissingGlobals(async () => {
    const { res } = await openResponse(`${base}/poster.jpg`, { timeoutMs: 5000 })
    t.is(res.statusCode, 200)
    t.is(res.headers['content-type'], 'image/jpeg', 'headers are readable before the body is pulled')
    const bytes = await readBody(res, { maxBytes: 1024 })
    t.is(bytes.byteLength, body.byteLength, 'the bytes arrive')

    const followed = await openResponse(`${base}/redirect`, { timeoutMs: 5000 })
    t.is(followed.res.statusCode, 200, 'a redirect is followed')
    t.ok(followed.finalUrl.endsWith('/poster.jpg'), 'and the final url is reported')
    await readBody(followed.res)

    // The ceiling is enforced on what is actually read, not on the length the
    // server claims, because the claim belongs to an origin we do not control.
    const capped = await openResponse(`${base}/poster.jpg`, { timeoutMs: 5000 })
    await t.exception(readBody(capped.res, { maxBytes: 2 }), /exceeded the 2 byte ceiling/)
  })
})

// A redirect loop must end, or an origin could hold a relay request open
// forever by bouncing it.
test('the vendored http client gives up on an endless redirect', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(302, { location: '/again' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))

  await withoutBareMissingGlobals(async () => {
    await t.exception(
      openResponse(`http://127.0.0.1:${server.address().port}/start`, { timeoutMs: 5000 }),
      /too many redirects/
    )
  })
})
