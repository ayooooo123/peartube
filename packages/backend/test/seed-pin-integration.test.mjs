import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'

import {
  randomTopic,
  spawnSeedPinSmokeChild,
  startLocalDhtBootstrap,
} from './fixtures/seed-pin-smoke.mjs'

const DEADLINE_MS = 60_000

function byKind (ranges, kind) {
  return ranges.find(range => range.kind === kind)
}

test('trusted relay pin survives interruption and publishes only after live full-range verification', async t => {
  t.timeout(DEADLINE_MS)
  const root = mkdtempSync(join(tmpdir(), 'peartube-seed-pin-integration-'))
  const uploaderStorage = join(root, 'uploader')
  const relayStorage = join(root, 'relay')
  const topic = randomTopic()
  const bootstrap = await startLocalDhtBootstrap({ timeout: DEADLINE_MS })
  let uploader = null
  let firstRelay = null
  let restartedRelay = null

  try {
    firstRelay = await spawnSeedPinSmokeChild({
      role: 'relay',
      storageDir: relayStorage,
      bootstrap: bootstrap.address,
      topic,
      gateDownloads: true,
      timeout: DEADLINE_MS,
    })
    const firstRelayReady = await firstRelay.waitFor('relay-ready')

    uploader = await spawnSeedPinSmokeChild({
      role: 'uploader',
      storageDir: uploaderStorage,
      bootstrap: bootstrap.address,
      topic,
      relayKey: firstRelayReady.swarmKey,
      timeout: DEADLINE_MS,
    })
    const uploaderReady = await uploader.waitFor('uploader-ready')

    t.alike(uploaderReady.trustedRelayKeys, [firstRelayReady.swarmKey], 'persisted relay link populates the trusted relay set')
    t.alike(uploaderReady.dialedRelayKeys, [firstRelayReady.swarmKey], 'the same trusted-key union drives direct dialing')
    t.is(uploaderReady.privateState, 'replicationPending', 'the imported row begins private')
    t.is(uploaderReady.publicVideoCount, 0, 'PublicBee is empty before durability')
    t.is(uploaderReady.publicFeedCount, 0, 'public feed is empty before durability')
    t.ok(byKind(uploaderReady.refs, 'media'), 'manifest binds a media range')
    t.ok(byKind(uploaderReady.refs, 'thumbnail'), 'manifest binds a thumbnail range')

    await firstRelay.request('start-relay', {
      uploaderSwarmKey: uploaderReady.swarmKey,
      uploaderIdentityKey: uploaderReady.identityKey,
      channelKey: uploaderReady.channelKey,
    }, 'relay-started')

    const uploaderConnection = await uploader.waitFor(
      'peer-connected',
      message => message.remoteKey === firstRelayReady.swarmKey,
    )
    const relayConnection = await firstRelay.waitFor(
      'peer-connected',
      message => message.remoteKey === uploaderReady.swarmKey,
    )
    t.is(uploaderConnection.remoteKey, firstRelayReady.swarmKey, 'uploader authenticates the exact configured relay Noise key')
    t.is(relayConnection.remoteKey, uploaderReady.swarmKey, 'relay admits only the expected uploader Noise key')

    await uploader.request('begin-replication', {}, 'replication-started')
    const accepted = await firstRelay.waitFor('pin-accepted')
    t.is(accepted.ownerIdentityKey, uploaderReady.identityKey, 'accepted request is owned by the authenticated uploader identity')
    t.is(accepted.ownerDeviceKey, uploaderReady.swarmKey, 'accepted request is bound to the live uploader device key')

    const interruptedRelay = await firstRelay.request('inspect', {}, 'relay-inspection')
    t.ok(['accepted', 'pinning'].includes(interruptedRelay.status), 'durable acceptance is persisted before interruption')
    t.is(interruptedRelay.complete, false, 'protocol completion is false at interruption')
    t.ok(interruptedRelay.ranges.every(range => range.local === false), 'relay has no complete local range while the pre-download gate is closed')

    await firstRelay.close()
    firstRelay = null
    const interruptedResult = await uploader.waitFor('replication-result')
    t.is(interruptedResult.result.status, 'replicationPending', 'disconnect after acceptance cannot publish')

    const interruptedUploader = await uploader.request('inspect', {}, 'uploader-inspection')
    t.is(interruptedUploader.privateState, 'replicationPending', 'private draft remains replicationPending after interruption')
    t.is(interruptedUploader.publicVideoCount, 0, 'PublicBee remains empty after interruption')
    t.is(interruptedUploader.publicFeedCount, 0, 'public feed remains empty after interruption')
    t.alike(interruptedUploader.bytes, uploaderReady.bytes, 'uploader retains every exact local media and thumbnail block')

    restartedRelay = await spawnSeedPinSmokeChild({
      role: 'relay',
      storageDir: relayStorage,
      bootstrap: bootstrap.address,
      topic,
      gateDownloads: false,
      timeout: DEADLINE_MS,
    })
    const restartedReady = await restartedRelay.waitFor('relay-ready')
    t.is(restartedReady.swarmKey, firstRelayReady.swarmKey, 'relay restart reuses the persisted swarm keypair')

    await restartedRelay.request('start-relay', {
      uploaderSwarmKey: uploaderReady.swarmKey,
      uploaderIdentityKey: uploaderReady.identityKey,
      channelKey: uploaderReady.channelKey,
    }, 'relay-started')
    await uploader.waitFor('peer-connected', message => message.remoteKey === restartedReady.swarmKey)
    await restartedRelay.waitFor('peer-connected', message => message.remoteKey === uploaderReady.swarmKey)

    const completeRelay = await restartedRelay.request('await-complete', {}, 'relay-inspection')
    t.is(completeRelay.status, 'complete', 'PinWorker.resume completes the accepted pin after restart')
    t.ok(completeRelay.complete, 'relay reports every requested range locally complete')
    t.ok(completeRelay.ranges.every(range => range.local === true), 'relay core.has proves every media and thumbnail block local')
    t.alike(completeRelay.bytes, uploaderReady.bytes, 'relay block bytes exactly match deterministic uploader bytes')
    const liveAssessment = await uploader.request('assess-now', {}, 'assessment-observed')
    t.ok(liveAssessment.assessment.eligible, 'actual aggregate assessor passes on live uploader peer bitfields')

    const publication = await uploader.request('resume-publication', {}, 'publication-result')
    t.is(publication.result.status, 'published', 'verified live ranges cross the publication barrier')
    t.is(publication.assessment.livePeerKey, restartedReady.swarmKey, 'assessment observes the authenticated relay connection key')
    t.alike(publication.assessment.fullCopyHolders, [restartedReady.swarmKey], 'one relay holds every requested range for the same item')
    t.alike(publication.assessment.trusted, [restartedReady.swarmKey], 'the full-copy holder qualifies through the trusted category')
    t.alike(publication.assessment.paired, [], 'trusted relay is not mislabeled as a paired device')
    t.alike(publication.assessment.ordinary, [], 'trusted relay is not counted as an ordinary peer')
    t.ok(publication.assessment.refs.every(ref => ref.holders.includes(restartedReady.swarmKey)), 'media and thumbnail observations both name the relay holder')

    const published = await uploader.request('inspect', {}, 'uploader-inspection')
    t.is(published.privateState, 'published', 'private row finalizes to published')
    t.is(published.publicVideoCount, 1, 'PublicBee contains exactly one public video')
    t.is(published.publicFeedCount, 1, 'public feed contains exactly one announcement')
    t.is(published.finalizeCalls, 1, 'the real finalization primitive runs once')

    const repeated = await uploader.request('restart-orchestration', {}, 'publication-result')
    t.is(repeated.result.status, 'published', 'fresh orchestration resumes the persisted published checkpoint')
    const afterRepeat = await uploader.request('inspect', {}, 'uploader-inspection')
    t.is(afterRepeat.publicVideoCount, 1, 'repeated orchestration does not duplicate PublicBee rows')
    t.is(afterRepeat.publicFeedCount, 1, 'repeated orchestration does not duplicate feed announcements')
    t.is(afterRepeat.finalizeCalls, 1, 'repeated orchestration does not refinalize')
  } finally {
    await Promise.allSettled([
      restartedRelay?.close(),
      firstRelay?.close(),
      uploader?.close(),
    ])
    await bootstrap.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('local DHT bootstrap failure destroys the bound node before rejecting', async t => {
  const expected = new Error('bootstrap-ready-failed')
  let destroyed = 0
  let unexpectedBootstrap = null
  let caught = null
  try {
    unexpectedBootstrap = await startLocalDhtBootstrap({
      timeout: 20,
      bootstrapper: () => ({
        ready: async () => { throw expected },
        async destroy ({ force }) {
          t.is(force, true, 'failed bootstrap is force-destroyed')
          destroyed++
        },
      }),
    })
  } catch (error) {
    caught = error
  } finally {
    await unexpectedBootstrap?.close()
  }

  t.is(caught, expected, 'the original readiness error is preserved')
  t.is(destroyed, 1, 'bootstrap cleanup runs exactly once')
})
