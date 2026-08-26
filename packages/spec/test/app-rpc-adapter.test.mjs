import test from 'brittle'
import c from 'compact-encoding'

import {
  APP_RPC_COMMANDS,
  APP_RPC_METADATA,
  APP_RPC_METHODS,
  PLATFORM_ONLY_COMMANDS,
  createGeneratedAppRpcClient
} from '../spec/hrpc/app-rpc-adapter.mjs'
import { SHARED_HANDLER_NAMES } from '../../backend/src/hrpc-handlers.js'

function unique(values) {
  return [...new Set(values)]
}

test('generated app RPC metadata is deterministic and covers classified schema commands', (t) => {
  t.ok(Array.isArray(APP_RPC_METADATA.commands), 'includes schema command metadata')
  t.ok(APP_RPC_METADATA.commands.length > APP_RPC_COMMANDS.length, 'tracks app and non-app HRPC commands')

  const schemaCommands = APP_RPC_METADATA.commands.map((entry) => entry.command)
  t.alike(schemaCommands, unique(schemaCommands), 'schema command names are unique')

  const appCommandsFromNamespaces = Object.values(APP_RPC_METADATA.namespaces).flatMap((methods) =>
    methods.map((method) => method.command)
  )
  t.alike([...APP_RPC_COMMANDS].sort(), [...appCommandsFromNamespaces].sort(), 'app command list matches namespaces')

  const classified = new Set([...APP_RPC_COMMANDS, ...PLATFORM_ONLY_COMMANDS])
  const unclassified = schemaCommands.filter((command) => !classified.has(command))
  t.alike(unclassified, [], 'all HRPC commands are classified as app-facing or platform-only')

  const systemMethods = APP_RPC_METADATA.namespaces.system.map((method) => method.method)
  for (const method of ['suspendNetwork', 'resumeNetwork', 'setPlaybackActive']) {
    t.ok(systemMethods.includes(method), `${method} is an app-facing system method`)
  }
  t.absent(APP_RPC_METADATA.namespaces.feed, 'legacy feed namespace is removed')
  for (const command of ['refresh-feed', 'submit-to-feed', 'unpublish-from-feed', 'is-channel-published']) {
    t.absent(APP_RPC_COMMANDS.includes(command), `${command} is not app-facing`)
  }
  t.ok(PLATFORM_ONLY_COMMANDS.includes('event-media-graph-update'), 'media graph update is platform-only')
  t.absent(PLATFORM_ONLY_COMMANDS.includes('event-feed-update'), 'legacy feed event is removed')
})

test('generated app RPC methods cover backend handler registration surface', (t) => {
  const schemaHandlers = new Set(APP_RPC_METADATA.commands.map((entry) => entry.handler))
  const missingSchemaHandlers = SHARED_HANDLER_NAMES.filter((handlerName) => !schemaHandlers.has(handlerName))
  t.alike(missingSchemaHandlers, [], 'shared backend handlers are present in HRPC schema')

  const backendHandlers = new Set(SHARED_HANDLER_NAMES)
  const appHandlersMissingBackend = APP_RPC_METADATA.commands
    .filter((entry) => APP_RPC_COMMANDS.includes(entry.command))
    .filter((entry) => !backendHandlers.has(entry.handler))
    .map((entry) => entry.handler)

  t.alike(appHandlersMissingBackend, [], 'app-facing generated methods have shared backend handlers')
})

test('generated app RPC facade invokes namespaced HRPC methods after ready', async (t) => {
  const calls = []
  let readyCalls = 0
  const rpc = {
    getStatus(request) {
      calls.push(['getStatus', request])
      return { ok: true }
    },
    listVideos(request) {
      calls.push(['listVideos', request])
      return { videos: [] }
    }
  }

  const client = createGeneratedAppRpcClient({
    rpc,
    async ready() {
      readyCalls += 1
    },
    createMissingMethodError(methodName) {
      return new Error(`missing:${methodName}`)
    },
    normalizeError(error) {
      return error
    }
  })

  t.is(APP_RPC_METHODS.system.getStatus, 'getStatus')
  t.is(APP_RPC_METHODS.video.listVideos, 'listVideos')

  t.alike(await client.system.getStatus({}), { ok: true })
  t.alike(await client.video.listVideos({ channelKey: 'abc' }), { videos: [] })
  t.is(readyCalls, 2)
  t.alike(calls, [
    ['getStatus', {}],
    ['listVideos', { channelKey: 'abc' }]
  ])

  await t.exception(() => client.video.getVideoUrl({}), /missing:getVideoUrl/)
})

test('generated app RPC facade marks explicitly provided optional request fields', async (t) => {
  let captured = null
  const client = createGeneratedAppRpcClient({
    rpc: {
      getContentItems(request) {
        captured = request
        return { success: false, errorCode: 'INVALID_LIMIT', items: [] }
      }
    },
    async ready() {},
    createMissingMethodError(methodName) {
      return new Error(`missing:${methodName}`)
    },
    normalizeError(error) {
      return error
    }
  })

  await client.channel.getContentItems({
    channelKey: '',
    publicBeeKey: 'public-bee-key',
    groupId: 'latest',
    limit: 0
  })

  t.ok(Object.hasOwn(captured, 'limit'))
  t.is(captured.limit, 0)
  t.is(captured.limitProvided, true)
})

test('generated network policy patch flags derive from own ceiling properties', async (t) => {
  const captured = []
  const client = createGeneratedAppRpcClient({
    rpc: {
      setNetworkPolicy(request) {
        captured.push(request)
        return { success: true }
      }
    },
    async ready() {},
    createMissingMethodError(methodName) {
      return new Error(`missing:${methodName}`)
    },
    normalizeError(error) {
      return error
    }
  })

  await client.system.setNetworkPolicy({ uploadPermission: 'enabled' })
  await client.system.setNetworkPolicy({ diskCeilingBytes: 0 })
  await client.system.setNetworkPolicy({ uploadCeilingBytes: 0 })

  t.alike(captured, [
    { uploadPermission: 'enabled' },
    { diskCeilingBytes: 0, diskCeilingBytesPresent: true },
    { uploadCeilingBytes: 0, uploadCeilingBytesPresent: true }
  ])
})

test('network policy HRPC distinguishes omitted ceilings from explicit zero', async (t) => {
  const schema = await import('@peartube/spec/schema')
  const encoding = schema.getEncoding('@peartube/set-network-policy-request')

  const unrelated = c.decode(encoding, c.encode(encoding, { uploadPermission: 'enabled' }))
  t.is(unrelated.diskCeilingBytes, 0)
  t.is(unrelated.uploadCeilingBytes, 0)
  t.is(unrelated.diskCeilingBytesPresent, false)
  t.is(unrelated.uploadCeilingBytesPresent, false)

  const explicitZero = c.decode(encoding, c.encode(encoding, {
    diskCeilingBytes: 0,
    diskCeilingBytesPresent: true,
    uploadCeilingBytes: 0,
    uploadCeilingBytesPresent: true
  }))
  t.is(explicitZero.diskCeilingBytes, 0)
  t.is(explicitZero.uploadCeilingBytes, 0)
  t.is(explicitZero.diskCeilingBytesPresent, true)
  t.is(explicitZero.uploadCeilingBytesPresent, true)
})

test('generated media catalog method preserves explicit limit presence', async (t) => {
  const captured = []
  const client = createGeneratedAppRpcClient({
    rpc: {
      getMediaCatalog(request) {
        captured.push(request)
        return { success: true, items: [] }
      }
    },
    async ready() {},
    createMissingMethodError(methodName) {
      return new Error(`missing:${methodName}`)
    },
    normalizeError(error) {
      return error
    }
  })

  await client.mediaGraph.getMediaCatalog({ limit: 0 })
  await client.mediaGraph.getMediaCatalog({})

  t.alike(captured, [
    { limit: 0, limitProvided: true },
    {}
  ])
})

test('generated index client reconstructs nullable uint presence without fake zero facts', async (t) => {
  const rawCandidate = present => ({
    work: { releaseYear: 0, releaseYearPresent: present },
    publication: { catalogEpoch: 0, catalogEpochPresent: present },
    rendition: {
      width: 0,
      widthPresent: present,
      height: 0,
      heightPresent: present,
      byteLength: 0,
      byteLengthPresent: present,
      audioTracks: [{ channels: 0, channelsPresent: present }]
    },
    asset: {
      blockLength: 0,
      blockLengthPresent: present,
      blockSize: 0,
      blockSizePresent: present,
      byteLength: 0,
      byteLengthPresent: present
    },
    availability: {
      peers: 0,
      peersPresent: present,
      completeSeeders: 0,
      completeSeedersPresent: present,
      observedAtMs: 0,
      observedAtMsPresent: present,
      expiresAtMs: 0,
      expiresAtMsPresent: present
    }
  })
  const client = createGeneratedAppRpcClient({
    rpc: {
      searchIndexCandidates() {
        return { success: true, candidates: [rawCandidate(false)] }
      },
      verifyIndexCandidate() {
        return { success: true, candidate: rawCandidate(true) }
      }
    },
    async ready() {},
    createMissingMethodError(methodName) {
      return new Error(`missing:${methodName}`)
    },
    normalizeError(error) {
      return error
    }
  })

  const searched = await client.search.searchIndexCandidates({})
  t.is(searched.candidates[0].work.releaseYear, null)
  t.is(searched.candidates[0].rendition.audioTracks[0].channels, null)
  t.is(searched.candidates[0].availability.observedAtMs, null)
  t.absent(Object.hasOwn(searched.candidates[0].work, 'releaseYearPresent'))
  const verified = await client.search.verifyIndexCandidate({})
  t.is(verified.candidate.work.releaseYear, 0)
  t.is(verified.candidate.rendition.audioTracks[0].channels, 0)
  t.is(verified.candidate.availability.observedAtMs, 0)
})

test('package exports resolve generated HRPC and schema entry points', async (t) => {
  const hrpc = await import('@peartube/spec')
  const messages = await import('@peartube/spec/messages')
  const schema = await import('@peartube/spec/schema')

  t.ok(hrpc.default || hrpc.HRPC, 'root export resolves generated HRPC client')
  t.ok(Object.keys(messages).length > 0, 'messages export resolves generated message codecs')
  t.ok(Object.keys(schema).length > 0, 'schema export resolves generated schema codecs')
})

test('preparePlayback response can encode a readiness miss without a URL', async (t) => {
  const schema = await import('@peartube/spec/schema')
  const encoding = schema.getEncoding('@peartube/prepare-playback-response')
  const encoded = c.encode(encoding, {
    url: null,
    warmupStarted: true,
    selectedBlobWarmup: {
      readyForPlayback: false,
      error: 'waiting-for-playable-head'
    }
  })
  const decoded = c.decode(encoding, encoded)

  t.is(decoded.url, null)
  t.is(decoded.warmupStarted, true)
  t.is(decoded.selectedBlobWarmup?.error, 'waiting-for-playable-head')
})

test('no HRPC command or app namespace exposes watch-event telemetry or server-side recommendations', (t) => {
  // Viewer ranking is device-local (packages/app/lib/local-recommendations.ts).
  // The wire must therefore offer no way to report what a viewer watched and no
  // way to ask a remote peer what to watch next. Personal watch history stays:
  // it is the viewer's own encrypted store, never a publisher-visible log.
  const telemetry = /watch-event|recommendation/
  const offending = APP_RPC_METADATA.commands
    .map((entry) => entry.command)
    .filter((command) => telemetry.test(command))
  t.alike(offending, [], 'schema exposes no watch-event or recommendation command')

  t.absent(APP_RPC_METADATA.namespaces.watch, 'the watch telemetry namespace is removed')
  const offendingMethods = Object.entries(APP_RPC_METADATA.namespaces).flatMap(([namespace, methods]) =>
    methods
      .filter((method) => /WatchEvent|Recommendation/.test(method.method))
      .map((method) => `${namespace}.${method.method}`)
  )
  t.alike(offendingMethods, [], 'no app-facing method reports viewing or fetches recommendations')

  t.ok(APP_RPC_COMMANDS.includes('log-watch-history'), 'the viewer\'s own encrypted history is untouched')
})
