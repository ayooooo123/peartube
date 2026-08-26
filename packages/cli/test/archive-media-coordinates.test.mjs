import test from 'brittle'
import { createArchiveManager, createArchivePublisher, deriveMediaCoordinates, enqueueArchiveJob, fetchPosterBytes, publishPosterArtwork } from '../src/archive-manager.js'
import { normalizeArchiveSubmission } from '../src/archive-api.js'

function memStore () {
  const jobs = []
  const inputs = {}
  return {
    async listJobs () { return jobs },
    async getPrivateInput (id) { return inputs[id] || null },
    async addJob (job, privateInput) { jobs.unshift(job); inputs[job.id] = privateInput; return job },
    async updateJob (id, patch) {
      const index = jobs.findIndex((job) => job.id === id)
      if (index >= 0) jobs[index] = { ...jobs[index], ...patch }
      return jobs[index] || null
    }
  }
}

function harness () {
  const store = memStore()
  const calls = { upload: [], seedChannel: [] }
  const downloader = {
    async download () {
      return { filePath: '/tmp/clip.mp4', title: 'Downloaded Title', duration: 10, size: 100, mimeType: 'video/mp4', cleanup () {} }
    }
  }
  const channelStub = { blobs: {}, publicBeeKey: 'pb1', getMetadata: async () => ({}) }
  const publisher = createArchivePublisher({
    identityManager: {
      getActiveIdentity: () => ({ publicKey: 'publisher-1', driveKey: 'ck1', channelKey: 'ck1' }),
      getActiveChannel: async () => channelStub
    },
    uploadManager: {
      async uploadFromPath (channel, filePath, options) { calls.upload.push(options); return { success: true, videoId: 'v1', metadata: {} } },
      async setThumbnailFromBuffer () { return { success: false } }
    },
    api: {},
    runtime: { publishPublisherCatalog: async () => ({ status: 'published' }) },
    fs: {},
    canPublish: retentionClass => retentionClass === 'archive-pin',
  })
  const manager = createArchiveManager({ store, downloader, publisher })
  return { store, manager, calls }
}

test('deriveMediaCoordinates maps movie/tv and rejects partial episode coords', (t) => {
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie', tmdbId: '603' }),
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1', tmdbEpisode: '3' }),
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', seasonNumber: 1, episodeNumber: 3 })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1' }), {}, 'tv without episode stays plain')
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie' }), {}, 'no tmdbId stays plain')
  t.alike(deriveMediaCoordinates({}), {})
})

test('discover-initiated episode archive persists coordinates on record and feed preview', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, {
    url: 'https://cdn.example/ep.mp4',
    title: 'Pilot',
    tmdbType: 'tv',
    tmdbId: '1396',
    tmdbSeason: '1',
    tmdbEpisode: '1',
    tmdbTitle: 'Breaking Bad',
    tmdbYear: '2008'
  })

  const completed = await manager.runJob(job.id)

  t.is(completed.status, 'completed')
  const upload = calls.upload[0]
  t.is(upload.contentKind, 'episode', 'canonical record gets contentKind')
  t.is(upload.mediaProvider, 'tmdb')
  t.is(upload.mediaId, '1396')
  t.is(upload.seasonNumber, 1)
  t.is(upload.episodeNumber, 1)

  const preview = completed.previewVideo
  t.is(preview.contentKind, 'episode', 'feed preview carries contentKind')
  t.is(preview.seasonNumber, 1)
  t.is(preview.episodeNumber, 1)
  t.is(preview.classification.type, 'tv')
  t.is(preview.classification.year, 2008)
})

test('movie archive persists movie coordinates without season/episode', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, {
    url: 'https://cdn.example/movie.mp4',
    tmdbType: 'movie',
    tmdbId: '603',
    tmdbTitle: 'The Matrix',
    tmdbYear: '1999'
  })

  const completed = await manager.runJob(job.id)

  const upload = calls.upload[0]
  t.is(upload.contentKind, 'movie')
  t.is(upload.mediaId, '603')
  t.absent('seasonNumber' in upload && upload.seasonNumber != null, 'no season on a movie')
  t.is(completed.previewVideo.contentKind, 'movie')
})

test('plain URL archive (no tmdb fields) is unchanged', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, { url: 'https://cdn.example/plain.mp4' })
  const completed = await manager.runJob(job.id)

  const upload = calls.upload[0]
  t.absent(upload.contentKind, 'no contentKind injected')
  t.absent(upload.mediaProvider)
  t.absent(completed.previewVideo.contentKind)
  t.absent(completed.previewVideo.classification)
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

test('an upload picked from the catalogue is named after the film, not the file', async (t) => {
  const store = memStore()
  const job = await enqueueArchiveJob(store, {
    uploadPath: '/tmp/WeddingCrashers2005REPACK1080pBluRay51YTSMX-xpost.mp4',
    uploadFilename: 'WeddingCrashers2005REPACK1080pBluRay51YTSMX-xpost.mp4',
    channelName: 'Archive',
    tmdbType: 'movie',
    tmdbId: '9522',
    tmdbTitle: 'Wedding Crashers',
    tmdbOverview: 'Two divorce mediators crash weddings to meet women.',
    tmdbYear: '2005'
  })

  t.is(job.title, 'Wedding Crashers', 'the catalogue name wins over the release filename')
  t.is(job.description, 'Two divorce mediators crash weddings to meet women.')

  const explicit = await enqueueArchiveJob(store, {
    uploadPath: '/tmp/clip.mp4',
    uploadFilename: 'clip.mp4',
    channelName: 'Archive',
    title: 'A name someone typed',
    tmdbType: 'movie',
    tmdbId: '9522',
    tmdbTitle: 'Wedding Crashers'
  })

  t.is(explicit.title, 'A name someone typed', 'an explicit title still outranks the catalogue')
})

test('the machine API carries discovered cover art, and refuses anything that is not a TMDB path', (t) => {
  // Cover art has to be published with the record: a consumer holds no
  // metadata-provider credentials, and a provider URL in the claim would make
  // browsing the catalog reach an origin outside the swarm. The console form
  // always carried this; the machine API dropped it, so every publication a
  // machine client seeded rendered as a blank card on every peer.
  const submission = {
    url: 'https://example.com/movie.mp4',
    contentKind: 'movie',
    tmdbId: '603',
    tmdbTitle: 'The Matrix',
    tmdbPosterPath: '/wr7nrhLIiFqEcOTZ4LBOJd9Kwsw.jpg',
  }
  const accepted = normalizeArchiveSubmission(submission)
  t.is(accepted.error, undefined, 'a TMDB artwork path is accepted')
  t.is(accepted.form.tmdbPosterPath, '/wr7nrhLIiFqEcOTZ4LBOJd9Kwsw.jpg',
    'the path reaches the job the publisher fetches from')

  // This value chooses an outbound request, so it is validated rather than
  // normalized into something that happens to work.
  for (const posterPath of [
    'https://evil.example/poster.jpg',
    '//evil.example/poster.jpg',
    '/../../etc/passwd',
    '/nested/path.jpg',
    'no-leading-slash.jpg',
    `/${'x'.repeat(200)}.jpg`,
  ]) {
    const rejected = normalizeArchiveSubmission({ ...submission, tmdbPosterPath: posterPath })
    t.is(rejected.error?.code, 'INVALID_POSTER_PATH', `${posterPath} is refused`)
  }

  const withoutArtwork = normalizeArchiveSubmission({ ...submission, tmdbPosterPath: undefined })
  t.is(withoutArtwork.error, undefined, 'artwork stays optional')
  t.is(withoutArtwork.form.tmdbPosterPath, '', 'a submission with no cover carries none')
})

test('the machine API carries the rest of the discovered metadata, bounded', (t) => {
  // A consumer cannot look any of this up either, so a title seeded without it
  // shows a name and nothing else on every peer that ever sees it.
  const submission = {
    url: 'https://example.com/movie.mp4',
    contentKind: 'movie',
    tmdbId: '680',
    tmdbTitle: 'Pulp Fiction',
  }
  const described = normalizeArchiveSubmission({
    ...submission,
    tmdbYear: '1994',
    tmdbRuntime: '154',
    tmdbGenres: 'Thriller,Crime',
    tmdbOverview: 'A burger-loving hit man and a washed-up boxer converge.',
  })
  t.is(described.error, undefined)
  t.is(described.form.tmdbYear, '1994')
  t.is(described.form.tmdbRuntime, '154')
  t.is(described.form.tmdbGenres, 'Thriller,Crime')
  t.ok(described.form.tmdbOverview.startsWith('A burger-loving'))

  // Refused rather than clamped: a year of 12 is a parse gone wrong, and
  // storing 1870 in its place would publish a confident wrong answer.
  const rejects = [
    ['tmdbYear', '12', 'INVALID_TMDB_YEAR'],
    ['tmdbYear', '9999', 'INVALID_TMDB_YEAR'],
    ['tmdbRuntime', '0', 'INVALID_TMDB_RUNTIME'],
    ['tmdbRuntime', '99999', 'INVALID_TMDB_RUNTIME'],
    ['tmdbOverview', 'x'.repeat(5000), 'INVALID_TMDB_OVERVIEW'],
    ['tmdbGenres', 'g'.repeat(600), 'INVALID_TMDB_GENRES'],
  ]
  for (const [field, value, code] of rejects) {
    t.is(normalizeArchiveSubmission({ ...submission, [field]: value }).error?.code, code, `${field} is bounded`)
  }

  const bare = normalizeArchiveSubmission(submission)
  t.is(bare.error, undefined, 'every descriptive field stays optional')
  t.is(bare.form.tmdbYear, '')
  t.is(bare.form.tmdbOverview, '')
})
