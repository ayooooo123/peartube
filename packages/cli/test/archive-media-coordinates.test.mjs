import test from 'brittle'
import { deriveMediaCoordinates, fetchPosterBytes, publishPosterArtwork } from '../src/archive-manager.js'

test('deriveMediaCoordinates maps movie/tv and rejects partial episode coords', (t) => {
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie', tmdbId: '603' }),
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1', tmdbEpisode: '3' }),
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', seasonNumber: 1, episodeNumber: 3 })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1' }), {}, 'tv without episode stays plain')
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie' }), {}, 'no tmdbId stays plain')
  t.alike(deriveMediaCoordinates({}), {})
})

// A consumer has no metadata-provider credentials, so cover art only reaches it
// if the publisher puts it on the record. Publishing a provider URL would not
// do that: the consumer would have to leave the swarm to fetch it, which leaks
// what it is browsing and fails wherever that origin is blocked or offline. The
// bytes are fetched once by the publisher and replicate like any other content.
test('the publisher fetches cover bytes rather than claiming a foreign origin', async (t) => {
  const requested = []
  const http = {
    async open (url) {
      requested.push(url)
      return { res: { statusCode: 200, headers: { 'content-type': 'image/jpeg' } } }
    },
    async read () { return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }
  }

  const poster = await fetchPosterBytes('/abc123.jpg', { http })
  t.is(requested.length, 1, 'the poster is fetched once, by the publisher')
  t.ok(requested[0].endsWith('/abc123.jpg'), 'the resolved poster path is fetched')
  t.is(poster.mimeType, 'image/jpeg')
  t.is(poster.bytes.byteLength, 4, 'the bytes themselves are what gets published')

  t.is(await fetchPosterBytes('   ', { http }), null, 'a blank poster path fetches nothing')
  t.is(await fetchPosterBytes('abc.jpg', { http }), null, 'a path that is not a poster path is refused')
  t.is(requested.length, 1, 'a path the function refuses is never requested')
})

test('a fetched cover is refused unless it is a bounded image', async (t) => {
  // Counts body reads, because refusing on the headers is the point: a wrong
  // type or an oversized cover must cost nothing but the response line.
  const reads = { count: 0 }
  const respond = (headers, bytes = new Uint8Array([1]), statusCode = 200) => ({
    async open () { return { res: { statusCode, headers } } },
    async read () { reads.count += 1; return bytes }
  })

  t.is(await fetchPosterBytes('/a.jpg', { http: respond({ 'content-type': 'text/html' }) }), null,
    'a document is not cover art')
  t.is(await fetchPosterBytes('/a.jpg', { http: respond({ 'content-type': 'image/jpeg', 'content-length': String(64 * 1024 * 1024) }) }), null,
    'an oversized cover is refused before it is read')
  t.is(reads.count, 0, 'neither one had its body pulled')

  t.is(await fetchPosterBytes('/a.jpg', { http: respond({ 'content-type': 'image/jpeg' }, new Uint8Array(0)) }), null,
    'an empty response is not cover art')
  t.is(await fetchPosterBytes('/a.jpg', { http: respond({ 'content-type': 'image/jpeg' }, null, 404) }), null,
    'a miss at the provider is not cover art')
  t.is(await fetchPosterBytes('/a.jpg', { http: { open: async () => { throw new Error('offline') } } }), null,
    'an unreachable provider degrades to no cover, not a failed archive')
})

// The cover has to land in the publisher's own blob core: that is what makes it
// replicate on the same swarm as the video instead of needing an origin.
test('a published cover names the blob a peer can replicate', async (t) => {
  const stored = []
  const channel = {
    blobsKeyHex: 'a'.repeat(64),
    async putBlob (bytes) {
      stored.push(bytes)
      return { id: '3:1:0:512' }
    },
  }

  const published = await publishPosterArtwork(channel, { bytes: Buffer.from([1, 2, 3]), mimeType: 'image/jpeg' })
  t.is(stored.length, 1, 'the bytes are written to the publisher blob core')
  t.alike(published, {
    artwork: [{ role: 'poster', blobId: '3:1:0:512', blobsCoreKey: 'a'.repeat(64), mimeType: 'image/jpeg' }],
  }, 'the claim names the blob, not a foreign origin')

  t.alike(await publishPosterArtwork(channel, null), {}, 'no cover claims nothing')
  t.alike(await publishPosterArtwork({ blobsKeyHex: null, putBlob: channel.putBlob }, { bytes: Buffer.from([1]), mimeType: 'image/jpeg' }), {},
    'a channel with no blob core claims nothing rather than an unreachable ref')
})
