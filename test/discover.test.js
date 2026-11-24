import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import { createDiscover, parseYoutubeFeedXml } from '../src/discover.js'
import { createApi } from '../src/http.js'

const YT_CHAN = 'UCSJ4gkVC6NrvII8umztf0Ow'
const SAMPLE_YT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Lofi Girl</title>
 <entry>
  <yt:videoId>nx32Ue0AAA0</yt:videoId>
  <yt:channelId>${YT_CHAN}</yt:channelId>
  <title>a rainy night &amp; lofi rain</title>
  <author><name>Lofi Girl</name></author>
  <published>2026-11-18T19:00:10+00:00</published>
  <media:group>
   <media:thumbnail url="https://i3.ytimg.com/vi/nx32Ue0AAA0/hqdefault.jpg"/>
  </media:group>
 </entry>
</feed>`

const SAMPLE_YT_HANDLE_HTML = `<!doctype html><html><head>
<link rel="canonical" href="https://www.youtube.com/channel/${YT_CHAN}">
<meta property="og:title" content="Lofi Girl">
<meta property="og:image" content="https://yt3.googleusercontent.com/lofi-avatar.jpg">
</head><body>{"channelId":"UCWRONG00000000000000000","externalId":"${YT_CHAN}"}</body></html>`

const SAMPLE_SC_HTML = '<html><script src="https://a-v2.sndcdn.com/assets/app.js"></script></html>'
const SAMPLE_SC_JS = 'const cfg = { client_id: "TESTSC1234567890abcdef" };'
const SAMPLE_RUMBLE_HTML = `<ul>
<li class="video-listing-entry">
  <a class="video-item--a" href="/v5abc12-rumble-clip.html" title="Rumble Creator Clip"></a>
  <h3>Rumble Creator Clip</h3>
  <span class="video-item--duration duration" data-value="04:20">04:20</span>
  <img src="https://sp.rmbl.ws/s8/1/a/b/c/clip.jpg" alt="Rumble Creator Clip">
  <div class="video-item--by-a">CreatorOne</div>
</li>
</ul>`

const PNG_BYTES = b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

test('parseYoutubeFeedXml parses Atom feed entries and decodes entities', () => {
  const { feedTitle, items } = parseYoutubeFeedXml(SAMPLE_YT_XML, { id: `youtube:${YT_CHAN}`, name: 'Lofi Girl', channelId: YT_CHAN, url: `https://www.youtube.com/channel/${YT_CHAN}` }, u => `/thumb/${u.length}`)
  assert.equal(feedTitle, 'Lofi Girl')
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'youtube:nx32Ue0AAA0')
  assert.equal(items[0].title, 'a rainy night & lofi rain')
  assert.equal(items[0].kind, 'video')
  assert.equal(items[0].audioOnly, false)
  assert.ok(items[0].acquireId.startsWith('clip:'))
  assert.ok(items[0].thumbnail.startsWith('/thumb/'))
})

test('discover HTTP endpoints: follow, feed, browse, thumb proxy, persistence, and unfollow', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-discover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let rumbleFail = false
  const entries = []
  const fetchBytes = async url => {
    if (url.includes('/@LofiGirl')) return { status: 200, headers: { 'content-type': 'text/html' }, body: b4a.from(SAMPLE_YT_HANDLE_HTML) }
    if (url.includes('feeds/videos.xml')) return { status: 200, headers: { 'content-type': 'application/xml' }, body: b4a.from(SAMPLE_YT_XML) }
    if (url === 'https://soundcloud.com') return { status: 200, headers: { 'content-type': 'text/html' }, body: b4a.from(SAMPLE_SC_HTML) }
    if (url.includes('sndcdn.com/assets/app.js')) return { status: 200, headers: { 'content-type': 'application/javascript' }, body: b4a.from(SAMPLE_SC_JS) }
    if (url.includes('/resolve?')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({
          kind: 'user',
          id: 4242,
          username: 'Nova Beats',
          permalink: 'nova-beats',
          permalink_url: 'https://soundcloud.com/nova-beats',
          avatar_url: 'https://i1.sndcdn.com/avatars-0001-large.jpg'
        }))
      }
    }
    if (url.includes('/users/4242/tracks')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({
          collection: [{
            id: 9001,
            title: 'Midnight Tape',
            permalink_url: 'https://soundcloud.com/nova-beats/midnight-tape',
            duration: 185000,
            created_at: '2026-11-20T12:00:00Z',
            artwork_url: 'https://i1.sndcdn.com/artworks-9001-large.jpg',
            user: { username: 'Nova Beats' }
          }]
        }))
      }
    }
    if (url.includes('rumble.com/c/CreatorOne')) {
      if (rumbleFail) return { status: 403, headers: { 'content-type': 'text/html' }, body: b4a.from('forbidden') }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: b4a.from(SAMPLE_RUMBLE_HTML) }
    }
    if (url.includes('yt3.googleusercontent.com') || url.includes('i3.ytimg.com') || url.includes('i1.sndcdn.com') || url.includes('sp.rmbl.ws')) {
      return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG_BYTES }
    }
    return { status: 404, headers: {}, body: b4a.from('') }
  }

  const fakeMirror = {
    async searchSources ({ query, sources }) {
      assert.equal(query, 'lofi')
      assert.ok(!sources.includes('soulseek'))
      return {
        results: [
          { source: 'soundcloud', trackId: '9001', title: 'Midnight Tape', artist: 'Nova Beats', url: 'https://soundcloud.com/nova-beats/midnight-tape', length: 185, thumbnail: '/v1/providers/soundcloud/thumb/9001' },
          { source: 'youtube', videoId: 'nx32Ue0AAA0', title: 'a rainy night & lofi rain', channel: 'Lofi Girl', url: 'https://www.youtube.com/watch?v=nx32Ue0AAA0', length: 3600, thumbnail: '/v1/providers/youtube/thumb/nx32Ue0AAA0' }
        ],
        errors: [{ source: 'rumble', status: 502, message: 'Rumble answered 403' }]
      }
    }
  }

  const discover = createDiscover({
    storage: dir,
    fetchBytes,
    getMirror: () => fakeMirror,
    getEntries: () => entries
  })

  const srv = createApi({ node: null, discover, fallbackStatus: { peers: 0 } })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => srv.close(resolve)))
  const base = `http://127.0.0.1:${srv.address().port}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, data: await res.json() }
  }

  // Follow YouTube creator by @handle (must pick canonical/externalId, not featured channelId)
  const ytFollow = await call('POST', '/v1/discover/creators', { url: '@LofiGirl' })
  assert.equal(ytFollow.status, 200)
  assert.equal(ytFollow.data.creator.id, `youtube:${YT_CHAN}`)
  assert.equal(ytFollow.data.creator.name, 'Lofi Girl')
  assert.match(ytFollow.data.creator.avatar, /^\/v1\/discover\/thumb\/[0-9a-f]{20}$/)

  // Follow SoundCloud artist and Rumble channel
  const scFollow = await call('POST', '/v1/discover/creators', { url: 'https://soundcloud.com/nova-beats' })
  assert.equal(scFollow.status, 200)
  assert.equal(scFollow.data.creator.id, 'soundcloud:4242')
  assert.equal(scFollow.data.creator.name, 'Nova Beats')

  const rmbFollow = await call('POST', '/v1/discover/creators', { url: 'https://rumble.com/c/CreatorOne' })
  assert.equal(rmbFollow.status, 200)
  assert.equal(rmbFollow.data.creator.id, 'rumble:c/creatorone')

  // Verify discover.json permissions (0600) and reload persistence
  assert.equal(statSync(join(dir, 'discover.json')).mode & 0o777, 0o600)
  const reloaded = createDiscover({ storage: dir, fetchBytes })
  assert.equal(reloaded.listCreators().creators.length, 3)

  // Feed returns all 3 sources, newest first, with audioOnly on SoundCloud
  const feedRes = await call('GET', '/v1/discover/feed?refresh=1')
  assert.equal(feedRes.status, 200)
  assert.equal(feedRes.data.items.length, 3)
  assert.equal(feedRes.data.errors.length, 0)
  const scItem = feedRes.data.items.find(i => i.source === 'soundcloud')
  assert.equal(scItem.audioOnly, true)
  assert.deepEqual(scItem.music, { title: 'Midnight Tape', artist: 'Nova Beats' })
  assert.equal(scItem.inLibrary, false)

  // Matching library entry flips inLibrary to true
  entries.push({ id: scItem.acquireId, title: 'Midnight Tape' })
  const feedAfterAdd = await call('GET', '/v1/discover/feed')
  assert.equal(feedAfterAdd.data.items.find(i => i.source === 'soundcloud').inLibrary, true)

  // Rumble 403 is surfaced cleanly in errors[] without breaking YouTube/SoundCloud
  rumbleFail = true
  const feedPartial = await call('GET', '/v1/discover/feed?refresh=1')
  assert.equal(feedPartial.status, 200)
  assert.equal(feedPartial.data.errors.length, 1)
  assert.equal(feedPartial.data.errors[0].source, 'rumble')

  // Proxied thumbnail works for owner, blocks cross-origin, returns 204 for unknown
  const thumbRes = await fetch(base + ytFollow.data.creator.avatar)
  assert.equal(thumbRes.status, 200)
  assert.equal(thumbRes.headers.get('content-type'), 'image/png')
  const evilThumb = await fetch(base + ytFollow.data.creator.avatar, { headers: { origin: 'http://evil.example' } })
  assert.equal(evilThumb.status, 403)
  const missingThumb = await fetch(base + '/v1/discover/thumb/00000000000000000000')
  assert.equal(missingThumb.status, 204)

  // Browse returns items + deduplicated creators with followed status
  const browseRes = await call('POST', '/v1/discover/browse', { query: 'lofi' })
  assert.equal(browseRes.status, 200)
  assert.equal(browseRes.data.items.length, 2)
  assert.ok(browseRes.data.creators.some(c => c.source === 'soundcloud' && c.name === 'Nova Beats' && c.followed === true))
  assert.ok(browseRes.data.creators.some(c => c.source === 'youtube' && c.name === 'Lofi Girl' && c.followed === true))

  // Unfollow removes creator
  const delRes = await call('DELETE', `/v1/discover/creators/${encodeURIComponent(scFollow.data.creator.id)}`)
  assert.equal(delRes.status, 200)
  assert.equal(delRes.data.removed, true)
  assert.equal(delRes.data.creators.length, 2)
})
