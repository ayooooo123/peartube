import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayService } from '../src/service.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createFakeRuntime() {
  let candidateHandler = null

  return {
    async start() {},
    setCandidateHandler(handler) {
      candidateHandler = handler
    },
    async emit(candidate) {
      if (!candidateHandler) throw new Error('candidate handler not set')
      await candidateHandler(candidate)
    },
    async resolveCandidate(candidate) {
      return {
        publicBeeKey: `bee-${candidate.channelKey}`,
        ownerKey: candidate.ownerKey || `owner-${candidate.channelKey}`,
        ...candidate
      }
    },
    getNetworkStats() {
      return { peers: 3, connections: 2 }
    },
    async close() {}
  }
}

test('createRelayService mirrors configured channels on start', async (t) => {
  const dir = makeTempDir('peartube-relay-service-start-')
  const runtime = createFakeRuntime()
  const mirrored = []
  let lastStatus = null

  try {
    const service = await createRelayService({
      config: {
        mode: 'private',
        policy: 'allowlist',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: ['chan-1'],
          owners: []
        },
        discovery: {
          enabled: false,
          maxChannels: 0,
          maxChannelsPerOwner: 0
        }
      },
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 2048, videosFound: 1, videosDownloaded: 1 }
      },
      writeStatusFile: async (_path, status) => {
        lastStatus = status
      }
    })

    await service.start()

    const status = service.getStatus()
    const channel = service.catalog.getChannel('chan-1')

    t.alike(mirrored, ['chan-1'])
    t.ok(channel)
    t.is(channel.retentionClass, 'private')
    t.is(channel.bytes, 2048)
    t.is(status.summary.totalChannels, 1)
    t.is(lastStatus.runtime.peers, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService accepts discovered channels in public discovery mode', async (t) => {
  const dir = makeTempDir('peartube-relay-service-discovery-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-2', source: 'discovered' })

    const channel = service.catalog.getChannel('chan-2')

    t.ok(channel)
    t.is(channel.retentionClass, 'discovery')
    t.is(channel.bytes, 4096)
    t.is(service.getStatus().summary.totalChannels, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
