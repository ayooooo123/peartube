// Verifies full-peer loopback API parity between the JS Bare worklet (`openPeerApi`)
// and peartube-native's `LoopbackApi`: settings, Discover v2, identify, acquire/jobs,
// and source providers (watch-dir, soulseek, youtube, soundcloud, rumble).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNode } from '../src/index.js'
import { openPeerApi } from '../src/peer-api.js'

async function reqJson (base, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

test('worklet/worker.js delegates to openPeerApi and src/identify.js has no static child_process import', () => {
  const workerSrc = readFileSync(new URL('../worklet/worker.js', import.meta.url), 'utf8')
  assert.match(workerSrc, /import\s*\{\s*openPeerApi\s*\}\s*from\s*'\.\.\/src\/peer-api\.js'/)
  assert.doesNotMatch(workerSrc, /acquirer:\s*null/)

  const identifySrc = readFileSync(new URL('../src/identify.js', import.meta.url), 'utf8')
  assert.doesNotMatch(identifySrc, /^\s*import\b.*['"](node:child_process|bare-subprocess)['"]/m)
})

test('openPeerApi exposes full-peer LoopbackApi routes matching peartube-native', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-peer-api-'))
  const mediaBytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
  const fixture = createServer((req, res) => {
    if (req.url === '/clip.mp4') {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(mediaBytes.length),
        'accept-ranges': 'bytes'
      })
      return res.end(req.method === 'HEAD' ? undefined : mediaBytes)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const fixturePort = fixture.address().port
  const mediaUrl = `http://127.0.0.1:${fixturePort}/clip.mp4`

  let node = null
  let peerApi = null
  const prevPrivate = process.env.PEARTUBE_ALLOW_PRIVATE_URLS
  process.env.PEARTUBE_ALLOW_PRIVATE_URLS = '1'
  try {
    node = await createNode({ storage: dir, bootstrap: [], worklet: true })
    peerApi = await openPeerApi({
      node,
      storage: dir,
      preferredPort: 0,
      allowPrivateUrls: true
    })
    await peerApi.ready
    assert.ok(peerApi.url?.startsWith('http://127.0.0.1:'))

    // 1. Status
    const st = await reqJson(peerApi.url, '/v1/status')
    assert.equal(st.status, 200)
    assert.ok(typeof st.json.tracker === 'string' && st.json.tracker.length === 64)

    // 2. Settings GET + PUT (live Soulseek config persisted to settings.json 0600)
    const getSet = await reqJson(peerApi.url, '/v1/settings')
    assert.equal(getSet.status, 200)
    assert.equal(getSet.json.settings.slskUser.value, '')
    assert.equal(getSet.json.settings.slskPass.set, false)

    const plugsBefore = await reqJson(peerApi.url, '/v1/plugins')
    assert.equal(plugsBefore.status, 200)
    const slskBefore = plugsBefore.json.plugins.find(p => p.name === 'soulseek')
    assert.equal(slskBefore?.configured, false)

    const putSet = await reqJson(peerApi.url, '/v1/settings', {
      method: 'PUT',
      body: { slskUser: 'alice', slskPass: 'secret-pass', slskServer: 'vps.slsknet.org:2271' }
    })
    assert.equal(putSet.status, 200)
    assert.equal(putSet.json.settings.slskUser.value, 'alice')
    assert.equal(putSet.json.settings.slskPass.set, true)
    assert.deepEqual(putSet.json.changed.sort(), ['slskPass', 'slskUser'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600)
    }

    // 3. Plugins list matches Rust LoopbackApi providers and reflects live Soulseek update
    const plugs = await reqJson(peerApi.url, '/v1/plugins')
    assert.equal(plugs.status, 200)
    const names = new Set((plugs.json.plugins || []).map(p => p.name))
    for (const required of ['watch-dir', 'soulseek', 'youtube', 'soundcloud', 'rumble']) {
      assert.ok(names.has(required), `missing plugin: ${required}`)
    }
    const slsk = plugs.json.plugins.find(p => p.name === 'soulseek')
    assert.equal(slsk.configured, true)

    // 4. Discover v2 routes are live (not 404)
    const creators = await reqJson(peerApi.url, '/v1/discover/creators')
    assert.equal(creators.status, 200)
    assert.deepEqual(creators.json.creators, [])

    const badCreator = await reqJson(peerApi.url, '/v1/discover/creators', {
      method: 'POST',
      body: { url: 'not-a-valid-url' }
    })
    assert.equal(badCreator.status, 400)

    const feed = await reqJson(peerApi.url, '/v1/discover/feed')
    assert.equal(feed.status, 200)
    assert.deepEqual(feed.json.items, [])

    const badBrowse = await reqJson(peerApi.url, '/v1/discover/browse', {
      method: 'POST',
      body: { query: '' }
    })
    assert.equal(badBrowse.status, 400)

    // 5. Identify direct media file URL
    const ident = await reqJson(peerApi.url, '/v1/identify', {
      method: 'POST',
      body: { url: mediaUrl }
    })
    assert.equal(ident.status, 200)
    assert.equal(ident.json.link.kind, 'file')
    assert.equal(ident.json.link.name, 'clip.mp4')

    // 6. Acquire direct media file + jobs list
    const acq = await reqJson(peerApi.url, '/v1/acquire', {
      method: 'POST',
      body: {
        id: 'clip:peerapiparity01',
        title: 'Clip Parity Test',
        source: { url: mediaUrl }
      }
    })
    assert.equal(acq.status, 200)
    assert.ok(acq.json.jobId)

    const jobs = await reqJson(peerApi.url, '/v1/jobs')
    assert.equal(jobs.status, 200)
    assert.ok(jobs.json.jobs.some(j => j.jobId === acq.json.jobId))

    // 7. Source search validation proves /v1/search/sources is wired
    const badSrcSearch = await reqJson(peerApi.url, '/v1/search/sources', {
      method: 'POST',
      body: { query: 'test', sources: ['nonexistent-provider'] }
    })
    assert.equal(badSrcSearch.status, 400)
    assert.match(badSrcSearch.json.error, /soulseek/)
    assert.match(badSrcSearch.json.error, /youtube/)
    assert.match(badSrcSearch.json.error, /soundcloud/)
    assert.match(badSrcSearch.json.error, /rumble/)
  } finally {
    if (prevPrivate === undefined) delete process.env.PEARTUBE_ALLOW_PRIVATE_URLS
    else process.env.PEARTUBE_ALLOW_PRIVATE_URLS = prevPrivate
    if (peerApi) await peerApi.close()
    if (node) await node.close()
    await new Promise(resolve => fixture.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
