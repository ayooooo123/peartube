import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createAssetManifestStore,
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  verifyPublicationManifest,
} from '../src/assets/index.js'
import { authorizeArchiveRequestFromManifestStore } from '../src/archive/permissionless-network.js'
import { createArchiveRequest } from '../src/archive/request.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'
import { createBootstrapLocator } from '../src/discovery/bootstrap-protocol.js'
import {
  createPublisherCatalogPage,
  verifyPublisherCatalogPage,
} from '../src/discovery/publisher-protocol.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import {
  createModerationFeedPage,
  verifyModerationFeedPage,
} from '../src/moderation/feed-contract.js'
import { createModerationManager, enforceModerationDecision } from '../src/moderation/manager.js'
import {
  createConsumerModerationPolicy,
  createConsumerModerationProfileController,
} from '../src/moderation/profile.js'
import { encodePeerFrame, PROTOCOL_MAJOR } from '../src/network/frame.js'
import {
  createScopedNetworkRuntime,
  createScopedProtocolSession,
  encodeScopedHello,
} from '../src/network/scoped-runtime.js'
import { derivePublisherTopic } from '../src/network/topics.js'
import {
  PUBLISHER_CATALOG_CAPABILITY,
  PUBLISHER_RECORD_TYPES,
  createPublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceProof,
} from '../src/publisher/index.js'
import {
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
} from '../src/records/application-envelope.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'

const bytes = (size, fill) => b4a.alloc(size, fill)
const hex = value => b4a.toString(b4a.from(value), 'hex')

function namespaceGenesis(descriptor, signer) {
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch: 0,
    issuerSequence: 0,
    signedAt: 10,
    canonicalBody: encodePublisherNamespaceDescriptor(descriptor),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey),
  )
}

function swarm() {
  const next = new EventEmitter()
  next.connections = new Set()
  next.join = () => ({
    flushed: async () => {},
    destroy() {},
    async suspend() {},
    async resume() {},
  })
  return next
}

function catalogPeer({ peerId, topic, publisherId, received }) {
  return createScopedProtocolSession({
    peerId,
    purpose: 'publisher',
    topic,
    protocolMajor: PROTOCOL_MAJOR,
    requiredCapability: PUBLISHER_CATALOG_CAPABILITY,
    onFrame: async frame => {
      if (frame.type !== 'catalog-page-response') return { status: 'rejected' }
      const envelope = decodeApplicationEnvelope(frame.payload)
      const verified = await verifyPublisherCatalogPage(envelope, {
        publisherId,
        now: 20,
      })
      if (!verified) return { status: 'rejected' }
      received.push(verified)
      return { status: 'accepted' }
    },
  })
}

test('curator signatures affect only local policy while publisher and media authority stay cryptographic', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 31))
  const curator = crypto.keyPair(bytes(32, 32))
  const requester = crypto.keyPair(bytes(32, 33))
  const coreKey = bytes(32, 34)
  const treeHash = bytes(32, 35)
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: createStaticAssetManifest({
      treeHash,
      blockLength: 4,
      byteLength: 4 * 262144,
    }),
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Publisher-authorized feature',
    renditions: [rendition],
    provenance: [{
      type: 'upload',
      renditionId: rendition.renditionId,
      coreKey: hex(coreKey),
      start: 0,
      end: 4,
    }],
    keyPair: publisher,
    signedAt: 10,
  })
  const forgedManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Curator forgery',
    renditions: [rendition],
    provenance: [{
      type: 'upload',
      renditionId: rendition.renditionId,
      coreKey: hex(coreKey),
      start: 0,
      end: 4,
    }],
    keyPair: curator,
    signedAt: 10,
  })

  t.ok(await verifyPublicationManifest(manifest, {
    allowedSigners: [publisher.publicKey],
    now: 20,
  }), 'the publisher authenticates its manifest and provenance')
  t.absent(await verifyPublicationManifest(forgedManifest, {
    allowedSigners: [publisher.publicKey],
    now: 20,
  }), 'a curator cannot authenticate publisher provenance')

  const manifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  t.is((await manifestStore.ingestManifest(manifest)).status, 'accepted')
  t.is((await manifestStore.ingestManifest(forgedManifest)).status, 'quarantined')

  const moderatorId = hex(curator.publicKey)
  const moderationPage = createModerationFeedPage({
    moderatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [{
      action: 'block',
      targetType: 'publication',
      targetId: manifest.publicationId,
      label: 'local-test-policy',
      reason: 'reader fixture',
    }],
    keyPair: curator,
    issuedAt: 10,
  })
  t.ok(await verifyModerationFeedPage(moderationPage.envelope, {
    moderatorId,
    now: 20,
  }), 'the same curator key has valid authority over its moderation page')

  const moderationManager = createModerationManager({ now: () => 20 })
  await moderationManager.subscribe(moderatorId)
  t.is((await moderationManager.syncFeed({
    moderatorId,
    fetchPage: async () => moderationPage,
  })).status, 'complete')

  const profileController = createConsumerModerationProfileController({
    bundledProfile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: [moderatorId],
    },
  })
  await profileController.ready
  const moderationPolicy = createConsumerModerationPolicy({
    profileController,
    moderationManager,
  })
  const candidate = {
    directPublisher: true,
    kind: 'movie',
    entityRef: 'work:publisher-authorized-feature',
    publicationId: manifest.publicationId,
    publisherId: hex(publisher.publicKey),
    title: manifest.body.title,
  }

  const locatorManager = createBootstrapManager({ now: () => 20, trustedSigners: [] })
  const curatorLocator = createBootstrapLocator({
    publisherId: hex(publisher.publicKey),
    catalogBootstrapKey: hex(bytes(32, 36)),
    catalogHead: hex(bytes(32, 37)),
    authorizationChainDigest: hex(bytes(32, 38)),
    issuedAt: 10,
    expiresAt: 100,
    keyPair: curator,
  })
  t.is((await locatorManager.ingestLocator('curator-peer', curatorLocator.envelope)).status, 'accepted')
  t.is(locatorManager.getLocator(hex(publisher.publicKey)).trusted, false)
  t.is(locatorManager.getLocator(hex(publisher.publicKey)).catalogChainVerified, false,
    'a curator locator is only an untrusted discovery candidate')

  let playbackPrepared = 0
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: locatorManager,
    publisherRecords: () => [candidate],
    moderationPolicy,
    onPlaybackPreparation: async record => {
      const retained = manifestStore.getManifest(record.publicationId)
      if (!retained || !await verifyPublicationManifest(retained, {
        allowedSigners: [publisher.publicKey],
        now: 20,
      })) throw new Error('playback manifest is not publisher-authorized')
      playbackPrepared++
    },
  })
  projection.rebuild()
  t.is(projection.getCatalog().items.length, 0, 'signed moderation blocks only the local projection')

  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: publisher.publicKey,
    catalogBootstrapKey: bytes(32, 36),
  })
  const genesis = namespaceGenesis(descriptor, publisher)
  const locatorTuple = {
    publisherId: hex(descriptor.publisherId),
    catalogBootstrapKey: hex(descriptor.catalogBootstrapKey),
    catalogEpoch: descriptor.catalogEpoch,
  }
  t.ok(verifyPublisherNamespaceProof({
    locator: locatorTuple,
    descriptor,
    genesis,
    transitions: [],
  }).valid, 'the publisher root authenticates the namespace proof')
  t.exception(() => verifyPublisherNamespaceProof({
    locator: locatorTuple,
    descriptor,
    genesis: namespaceGenesis(descriptor, curator),
    transitions: [],
  }), /authority|bind|signature|signer/i, 'the curator cannot authenticate a publisher proof')

  const catalogPage = createPublisherCatalogPage({
    publisherId: hex(publisher.publicKey),
    pageCursor: '0',
    nextCursor: null,
    catalogHead: hex(bytes(32, 37)),
    batches: [],
    keyPair: publisher,
    issuedAt: 10,
  })
  const forgedCatalogPage = createPublisherCatalogPage({
    publisherId: hex(publisher.publicKey),
    pageCursor: '0',
    nextCursor: null,
    catalogHead: hex(bytes(32, 37)),
    batches: [],
    keyPair: curator,
    issuedAt: 10,
  })
  t.ok(await verifyPublisherCatalogPage(catalogPage.envelope, {
    publisherId: hex(publisher.publicKey),
    now: 20,
  }))
  t.absent(await verifyPublisherCatalogPage(forgedCatalogPage.envelope, {
    publisherId: hex(publisher.publicKey),
    now: 20,
  }), 'the curator cannot authenticate publisher catalog state')

  const topic = derivePublisherTopic({
    publisherId: descriptor.publisherId,
    catalogBootstrapKey: descriptor.catalogBootstrapKey,
    catalogEpoch: 0,
  })
  const peers = [
    { id: 'consumer-one', received: [] },
    { id: 'consumer-two', received: [] },
  ]
  for (const peer of peers) {
    const session = catalogPeer({
      peerId: peer.id,
      topic,
      publisherId: hex(publisher.publicKey),
      received: peer.received,
    })
    await session.acceptHello(encodeScopedHello({
      purpose: 'publisher',
      topic,
      protocolMajor: PROTOCOL_MAJOR,
      capabilities: [PUBLISHER_CATALOG_CAPABILITY],
      maxFrameBytes: 64 * 1024,
    }))
    t.is((await session.receive(encodePeerFrame({
      purpose: 'publisher',
      type: 'catalog-page-response',
      requestId: 1,
      payload: encodeApplicationEnvelope(catalogPage.envelope),
    }))).status, 'accepted')
    t.is((await session.receive(encodePeerFrame({
      purpose: 'publisher',
      type: 'catalog-page-response',
      requestId: 2,
      payload: encodeApplicationEnvelope(forgedCatalogPage.envelope),
    }))).status, 'rejected')
    session.close()
  }
  t.alike(peers.map(peer => peer.received.length), [1, 1],
    'two independent transport peers accept only publisher-authenticated pages')

  const opened = []
  const runtime = createScopedNetworkRuntime({
    swarm: swarm(),
    store: {
      get({ key }) {
        opened.push(hex(key))
        return {
          key,
          ready: async () => {},
          download: () => ({ destroy() {} }),
          close: async () => {},
        }
      },
    },
    now: () => 20,
    authorizePublication: async ({ manifest: proposed }) => {
      const retained = manifestStore.getManifest(proposed?.publicationId)
      return retained === proposed && verifyPublicationManifest(proposed, {
        allowedSigners: [publisher.publicKey],
        now: 20,
      })
    },
    authorizeConsumerWork: ({ publicationId }) => (
      enforceModerationDecision(moderationPolicy.evaluate({ publicationId }), 'download').allowed
    ),
  })
  await runtime.start()
  await t.exception(runtime.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: 4,
  }), /not visible|local policy/i, 'local moderation can decline media work')
  await t.exception(runtime.retainAuthorizedRendition({
    manifest: forgedManifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: 4,
  }), /not authorized|manifest/i, 'a curator forgery cannot be retained')
  t.is(opened.length, 0)

  await profileController.replace({
    version: 1,
    enabled: true,
    curatorSubscriptions: [],
  })
  await moderationManager.unsubscribe(moderatorId)
  projection.rebuild()
  t.alike(profileController.getEffectiveCuratorSubscriptions(), [])
  t.alike(projection.getCatalog().items.map(item => item.entityRef), [candidate.entityRef],
    'removing every curator leaves the authenticated publisher record discoverable')
  t.is((await projection.schedule(candidate.entityRef, ['playback'])).scheduled, true)
  t.is(playbackPrepared, 1, 'playback remains gated by the publisher manifest, not curator membership')

  t.is((await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: 4,
  })).status, 'retained')
  t.alike(opened, [rendition.core.key], 'local allow permits publisher-authorized media retention')

  const archiveRequest = createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId: manifest.publicationId,
    renditionId: rendition.renditionId,
    ranges: [{ coreKey: rendition.core.key, start: 0, end: 4 }],
    requestedBytes: rendition.core.byteLength,
    retentionUntil: 200,
    expiresAt: 100,
    issuedAt: 20,
    keyPair: requester,
  })
  const authorizeRendition = async ({ manifest: proposed, renditionId, start, end }) => (
    manifestStore.getManifest(proposed?.publicationId) === proposed &&
    await verifyPublicationManifest(proposed, {
      allowedSigners: [publisher.publicKey],
      now: 20,
    }) &&
    proposed.body.renditions.some(item => (
      item.renditionId === renditionId &&
      start === 0 &&
      end === item.core.length
    ))
  )
  t.ok(await authorizeArchiveRequestFromManifestStore(archiveRequest, {
    manifestStore,
    authorizeRendition,
  }), 'archive authority follows the authenticated publisher manifest')

  const curatorPublication = createPublicationManifest({
    publisherId: curator.publicKey,
    sequence: 1,
    title: 'Curator-originated media',
    renditions: [rendition],
    keyPair: curator,
    signedAt: 10,
  })
  const curatorArchiveRequest = createArchiveRequest({
    requesterId: curator.publicKey,
    publicationId: curatorPublication.publicationId,
    renditionId: rendition.renditionId,
    ranges: [{ coreKey: rendition.core.key, start: 0, end: 4 }],
    requestedBytes: rendition.core.byteLength,
    retentionUntil: 200,
    expiresAt: 100,
    issuedAt: 20,
    keyPair: curator,
  })
  t.is(await authorizeArchiveRequestFromManifestStore(curatorArchiveRequest, {
    manifestStore,
    authorizeRendition,
  }), false, 'moderation authority cannot invent archive authority for uncatalogued media')

  t.ok(await verifyPublisherCatalogPage(peers[0].received[0].envelope, {
    publisherId: hex(publisher.publicKey),
    now: 20,
  }), 'publisher pages remain valid after all curators are removed')
  t.ok(verifyPublisherNamespaceProof({
    locator: locatorTuple,
    descriptor,
    genesis,
    transitions: [],
  }).valid, 'publisher discovery proof remains valid after all curators are removed')

  await runtime.close()
})
