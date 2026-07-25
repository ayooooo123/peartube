import test from 'brittle'
import c from 'compact-encoding'

import {
  APP_RPC_COMMANDS,
  APP_RPC_METADATA,
  APP_RPC_METHODS,
  PLATFORM_ONLY_COMMANDS,
  RUNTIME_ONLY_METHODS,
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

  t.ok(RUNTIME_ONLY_METHODS.includes('suspendNetwork'), 'documents runtime-only platform methods')
  t.ok(RUNTIME_ONLY_METHODS.includes('resumeNetwork'), 'documents runtime-only platform methods')
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
