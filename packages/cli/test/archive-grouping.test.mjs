import test from 'brittle'
import { createArchivePublisher, deriveArchiveSourceIdentity } from '../src/archive-manager.js'

test('deriveArchiveSourceIdentity keys shows/movies at the title level', function (t) {
  t.alike(
    deriveArchiveSourceIdentity({ tmdbType: 'tv', tmdbId: '95396', tmdbSeason: '1', tmdbEpisode: '2', tmdbTitle: 'Severance' }),
    { platform: 'tmdb', sourceId: 'tmdb:tv:95396', creatorName: 'Severance', creatorHandle: null },
    'a TV episode keys on the show (no season/episode) so episodes group'
  )
  t.alike(
    deriveArchiveSourceIdentity({ tmdbType: 'movie', tmdbId: '603', tmdbTitle: 'The Matrix' }),
    { platform: 'tmdb', sourceId: 'tmdb:movie:603', creatorName: 'The Matrix', creatorHandle: null }
  )
  t.is(deriveArchiveSourceIdentity({ channelName: 'Anonymous' }), null, 'plain archive has no source identity')
})

function stubChannel (name) {
  return {
    writable: true,
    blobs: {},
    _meta: {},
    async getMetadata () { return this._meta },
    async updateMetadata (patch) { this._meta = { ...this._meta, ...patch } },
    async ensureLocalBlobDrive () {},
    publicBeeKey: `bee-${name}`
  }
}

function publisherWith (createChannelFn) {
  return createArchivePublisher({
    identityManager: {
      getActiveIdentity: () => ({ driveKey: 'active-channel' }),
      getActiveChannel: async () => stubChannel('active')
    },
    uploadManager: {},
    api: {},
    runtime: { ctx: {} },
    fs: {},
    createChannelFn
  })
}

test('ensureAnonymousChannel creates one deterministic channel per show and reuses it', async function (t) {
  const created = []
  const publisher = publisherWith(async (ctx, opts) => {
    created.push(opts.writerKeyName)
    return { channel: stubChannel(opts.writerKeyName), channelKeyHex: `ck-${opts.writerKeyName}` }
  })
  const identity = deriveArchiveSourceIdentity({ tmdbType: 'tv', tmdbId: '95396', tmdbTitle: 'Severance' })

  const first = await publisher.ensureAnonymousChannel({ channelName: 'Severance', sourceIdentity: identity })
  const second = await publisher.ensureAnonymousChannel({ channelName: 'Severance', sourceIdentity: identity })

  t.is(created.length, 1, 'the show channel is created once, then cached')
  t.is(created[0], 'peartube-archive-writer:tmdb:tv:95396', 'deterministic writer key from the show source id')
  t.is(first.channelKey, second.channelKey, 'both episodes resolve to the same channel')
  t.is(first.publicBeeKey, 'bee-peartube-archive-writer:tmdb:tv:95396')
})

test('ensureAnonymousChannel falls back to the shared channel when createChannel fails', async function (t) {
  const publisher = publisherWith(async () => { throw new Error('boom') })
  const identity = deriveArchiveSourceIdentity({ tmdbType: 'movie', tmdbId: '603', tmdbTitle: 'The Matrix' })
  const info = await publisher.ensureAnonymousChannel({ channelName: 'The Matrix', sourceIdentity: identity })
  t.is(info.channelKey, 'active-channel', 'archiving never hard-fails: falls back to the shared channel')
})

test('ensureAnonymousChannel uses the shared channel for plain archives', async function (t) {
  const publisher = publisherWith(async () => { throw new Error('must not be called') })
  const info = await publisher.ensureAnonymousChannel({ channelName: 'Anonymous Archive', sourceIdentity: null })
  t.is(info.channelKey, 'active-channel')
})
