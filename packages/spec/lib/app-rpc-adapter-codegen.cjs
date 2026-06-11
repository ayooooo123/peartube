'use strict'

const fs = require('fs')
const path = require('path')

const APP_RPC_NAMESPACES = Object.freeze({
  system: [
    'get-status',
    'get-swarm-status',
    'get-blob-server-port'
  ],
  identity: [
    'create-identity',
    'get-identity',
    'get-identities',
    'set-active-identity',
    'recover-identity',
    'create-device-invite',
    'pair-device',
    'list-devices',
    'bootstrap-device',
    'attest-device',
    'verify-attestation'
  ],
  feed: [
    'get-canonical-feed',
    'get-public-feed',
    'refresh-feed',
    'submit-to-feed',
    'unpublish-from-feed',
    'is-channel-published',
    'subscribe-channel',
    'unsubscribe-channel',
    'get-subscriptions',
    'join-channel',
    'hide-channel',
    'pin-channel',
    'unpin-channel',
    'get-pinned-channels'
  ],
  channel: [
    'get-channel',
    'get-channel-meta',
    'update-channel',
    'update-channel-avatar'
  ],
  video: [
    'list-videos',
    'get-video-url',
    'prepare-playback',
    'web-prepare-playback',
    'get-video-data',
    'get-video-metadata',
    'get-video-thumbnail',
    'get-video-stats',
    'prefetch-video',
    'delete-video',
    'update-video-metadata',
    'set-video-thumbnail',
    'set-video-thumbnail-from-file',
    'add-comment',
    'list-comments',
    'hide-comment',
    'remove-comment',
    'add-reaction',
    'remove-reaction',
    'get-reactions'
  ],
  live: [
    'start-livestream',
    'stop-livestream',
    'get-livestream-status',
    'prepare-live-playback'
  ],
  watch: [
    'log-watch-event',
    'get-recommendations',
    'get-video-recommendations'
  ],
  transfer: [
    'upload-video',
    'download-video',
    'get-seeding-status',
    'set-seeding-config',
    'get-storage-stats',
    'set-storage-limit',
    'clear-cache'
  ],
  search: [
    'search-videos',
    'global-search-videos',
    'index-video-vectors'
  ],
  shell: [
    'pick-video-file',
    'pick-image-file',
    'get-transcode-settings',
    'set-transcode-settings',
    'ffmpeg-decode-available',
    'cast-available',
    'cast-start-discovery',
    'cast-stop-discovery',
    'cast-get-devices',
    'cast-add-manual-device',
    'cast-connect',
    'cast-disconnect',
    'cast-play',
    'cast-pause',
    'cast-resume',
    'cast-stop',
    'cast-seek',
    'cast-set-volume',
    'cast-get-state',
    'cast-is-connected',
    'transcode-start',
    'transcode-stop',
    'transcode-status'
  ]
})

const RUNTIME_ONLY_METHODS = Object.freeze([
  // Exposed by the native/desktop platform bridge, not the schema HRPC surface.
  'suspendNetwork',
  'resumeNetwork',
  'setPlaybackActive'
])

const PLATFORM_ONLY_COMMANDS = Object.freeze([
  // Backend lifecycle and push events are registered in HRPC but consumed by
  // platform runners/event maps instead of the app-facing request facade.
  'desktop-bootstrap',
  'desktop-shutdown',
  'desktop-refresh-browse',
  'event-ready',
  'event-error',
  'event-upload-progress',
  'event-download-progress',
  'event-feed-update',
  'event-log',
  'event-video-stats',
  'event-transcode-progress',
  'event-cast-device-found',
  'event-cast-device-lost',
  'event-cast-playback-state',
  'event-cast-time-update',
  'retry-sync-channel'
])

function stripNamespace(name) {
  return name.replace(/^@peartube\//, '')
}

function toCamelCase(commandName) {
  return commandName.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
}

function toPascalCase(commandName) {
  const camel = toCamelCase(commandName)
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`
}

function readHrpcSchema(hrpcJsonPath) {
  const hrpc = JSON.parse(fs.readFileSync(hrpcJsonPath, 'utf8'))
  return hrpc.schema.map((entry) => {
    const command = stripNamespace(entry.name)
    return {
      id: entry.id,
      command,
      method: toCamelCase(command),
      handler: toPascalCase(command),
      request: entry.request?.name ?? null,
      response: entry.response?.name ?? null,
      send: Boolean(entry.request?.send),
      requestStream: Boolean(entry.request?.stream),
      responseStream: Boolean(entry.response?.stream)
    }
  })
}

function createAppRpcMetadata(entries) {
  const byCommand = new Map(entries.map((entry) => [entry.command, entry]))
  const namespaces = {}
  const appCommands = new Set()

  for (const [namespace, commands] of Object.entries(APP_RPC_NAMESPACES)) {
    namespaces[namespace] = commands.map((command) => {
      const entry = byCommand.get(command)
      if (!entry) throw new Error(`Missing HRPC command for app namespace ${namespace}: ${command}`)
      appCommands.add(command)
      return { ...entry }
    })
  }

  const platformOnly = PLATFORM_ONLY_COMMANDS.map((command) => {
    const entry = byCommand.get(command)
    if (!entry) throw new Error(`Missing platform-only HRPC command: ${command}`)
    return { ...entry }
  })

  const schemaCommands = entries.map((entry) => entry.command)
  const classifiedCommands = new Set([...appCommands, ...PLATFORM_ONLY_COMMANDS])
  const unclassified = schemaCommands.filter((command) => !classifiedCommands.has(command))
  if (unclassified.length) {
    throw new Error(`Unclassified HRPC commands: ${unclassified.join(', ')}`)
  }

  return {
    generatedAt: 'schema-build',
    commands: entries,
    namespaces,
    appCommands: [...appCommands].sort(),
    platformOnlyCommands: platformOnly,
    runtimeOnlyMethods: [...RUNTIME_ONLY_METHODS]
  }
}

function generateAppRpcAdapterSource(metadata) {
  const json = JSON.stringify(metadata, null, 2)

  return `// This file is autogenerated by packages/spec/schema.cjs\n` +
    `// Do not edit directly. Update packages/spec/lib/app-rpc-adapter-codegen.cjs instead.\n\n` +
    `export const APP_RPC_METADATA = Object.freeze(${json})\n\n` +
    `export const APP_RPC_METHODS = Object.freeze(Object.fromEntries(\n` +
    `  Object.entries(APP_RPC_METADATA.namespaces).map(([namespace, methods]) => [\n` +
    `    namespace,\n` +
    `    Object.freeze(Object.fromEntries(methods.map((method) => [method.method, method.method])))\n` +
    `  ])\n` +
    `))\n\n` +
    `export const APP_RPC_COMMANDS = Object.freeze(APP_RPC_METADATA.appCommands)\n` +
    `export const PLATFORM_ONLY_COMMANDS = Object.freeze(APP_RPC_METADATA.platformOnlyCommands.map((command) => command.command))\n` +
    `export const RUNTIME_ONLY_METHODS = Object.freeze(APP_RPC_METADATA.runtimeOnlyMethods)\n\n` +
    `function createMethodCaller(rpc, ready, methodName, createMissingMethodError, normalizeError) {\n` +
    `  return async (request = {}) => {\n` +
    `    await ready()\n` +
    `    const method = rpc?.[methodName]\n` +
    `    if (typeof method !== 'function') throw createMissingMethodError(methodName)\n` +
    `    try {\n` +
    `      return await method.call(rpc, request)\n` +
    `    } catch (error) {\n` +
    `      throw normalizeError(error)\n` +
    `    }\n` +
    `  }\n` +
    `}\n\n` +
    `export function createGeneratedAppRpcClient({ rpc, ready, createMissingMethodError, normalizeError }) {\n` +
    `  if (typeof ready !== 'function') throw new Error('createGeneratedAppRpcClient requires ready()')\n` +
    `  if (typeof createMissingMethodError !== 'function') throw new Error('createGeneratedAppRpcClient requires createMissingMethodError()')\n` +
    `  if (typeof normalizeError !== 'function') throw new Error('createGeneratedAppRpcClient requires normalizeError()')\n\n` +
    `  return Object.fromEntries(\n` +
    `    Object.entries(APP_RPC_METADATA.namespaces).map(([namespace, methods]) => [\n` +
    `      namespace,\n` +
    `      Object.fromEntries(methods.map((method) => [\n` +
    `        method.method,\n` +
    `        createMethodCaller(rpc, ready, method.method, createMissingMethodError, normalizeError)\n` +
    `      ]))\n` +
    `    ])\n` +
    `  )\n` +
    `}\n`
}

function writeAppRpcAdapter({ hrpcJsonPath, outputPath }) {
  const entries = readHrpcSchema(hrpcJsonPath)
  const metadata = createAppRpcMetadata(entries)
  const source = generateAppRpcAdapterSource(metadata)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, source)
  return metadata
}

module.exports = {
  APP_RPC_NAMESPACES,
  PLATFORM_ONLY_COMMANDS,
  RUNTIME_ONLY_METHODS,
  createAppRpcMetadata,
  generateAppRpcAdapterSource,
  readHrpcSchema,
  stripNamespace,
  toCamelCase,
  toPascalCase,
  writeAppRpcAdapter
}
