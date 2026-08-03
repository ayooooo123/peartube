import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import {
  PersonalStore,
  PERSONAL_INVITE_MAX_TTL_MS,
  PERSONAL_STATE_EXPORT_VERSION,
  comparePersonalProgressOrder,
  mergePersonalProgress,
  personalProgressStateKey,
  parsePersonalProgressStateKey,
  encodePersonalPairingUserData
} from '../src/personal/personal-store.js'
import { generateSecret } from '../src/personal/personal-crypto.js'

function tmpStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-test-'))
  const store = new Corestore(dir)
  return { store, dir }
}

/** Open a store, run `fn`, then tear the temp corestore down. */
async function withStore (opts, fn) {
  const { store, dir } = tmpStore()
  await store.ready()
  const ps = new PersonalStore(store, opts)
  await ps.ready()
  try {
    await fn(ps, store)
  } finally {
    await ps.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const IDENTITY = { entityRef: 'entity:tt1', editionRef: 'edition:1080p', memberRef: 'member:s1e1' }
const STATE_KEY = personalProgressStateKey({ identity: IDENTITY })

function order (playbackGeneration, lamport, writerKey, tombstone = false) {
  return { playbackGeneration, lamport, writerKey, tombstone }
}

test('personal store: owner is writable and round-trips all data types', async (t) => {
  const { store, dir } = tmpStore()
  await store.ready()
  const ps = new PersonalStore(store, {})
  await ps.ready()

  t.ok(ps.writable, 'creator is writable')
  t.ok(ps.keyHex, 'has a bootstrap key')

  await ps.subscribe('a'.repeat(64), { name: 'Chan' })
  t.is((await ps.listSubscriptions()).length, 1, 'subscription stored')
  await ps.unsubscribe('a'.repeat(64))
  t.is((await ps.listSubscriptions()).length, 0, 'subscription removed')

  const plId = await ps.createPlaylist({ name: 'Watch Later' })
  await ps.addToPlaylist(plId, { channelKey: 'c'.repeat(64), videoId: 'v1' })
  t.is((await ps.listPlaylists()).length, 1, 'playlist stored')
  t.is((await ps.listPlaylistItems(plId)).length, 1, 'playlist item stored')
  await ps.deletePlaylist(plId)
  t.is((await ps.listPlaylists()).length, 0, 'playlist deleted')
  t.is((await ps.listPlaylistItems(plId)).length, 0, 'playlist items cascade-deleted')

  await ps.logHistory({ videoKey: 'vk1', title: 'Ep 1', duration: 600, position: 120 })
  const hist = await ps.listHistory()
  t.is(hist[0].videoKey, 'vk1', 'history newest-first')
  t.is((await ps.getResume('vk1')).position, 120, 'resume position tracked')

  await ps.setSetting('theme', 'dark')
  t.is(await ps.getSetting('theme'), 'dark', 'setting stored')

  await ps.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('personal store: deterministic key reopens writable with persisted data', async (t) => {
  const { store, dir } = tmpStore()
  await store.ready()
  const ns = 'peartube-personal:pk'

  const a = new PersonalStore(store, { namespace: ns })
  await a.ready()
  const key = a.keyHex
  await a.setSetting('k', 'v')
  await a.close()

  const b = new PersonalStore(store, { namespace: ns })
  await b.ready()
  t.is(b.keyHex, key, 'same namespace reproduces the same store key')
  t.ok(b.writable, 'reopened writable')
  t.is(await b.getSetting('k'), 'v', 'data persisted across reopen')

  await b.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('progress state keys: media identity is canonical, videoKey only a legacy fallback', (t) => {
  t.is(STATE_KEY, 'entity:tt1|edition:1080p|member:s1e1', 'identity triple joined in order')
  t.is(personalProgressStateKey({ identity: { entityRef: 'e' } }), 'e||', 'missing refs are empty, not dropped')
  t.is(personalProgressStateKey({ videoKey: 'chan:vid' }), 'chan:vid', 'legacy key used when no identity')
  t.alike(parsePersonalProgressStateKey(STATE_KEY), { identity: IDENTITY, videoKey: '' }, 'identity round-trips')
  t.alike(parsePersonalProgressStateKey('chan:vid'), { identity: null, videoKey: 'chan:vid' }, 'legacy key round-trips')
})

test('progress ordering: (playbackGeneration, lamport, writerKey) decides, never wall-clock', (t) => {
  t.is(comparePersonalProgressOrder(order(1, 0, 'aa'), order(0, 999, 'zz')), 1, 'generation dominates lamport')
  t.is(comparePersonalProgressOrder(order(0, 5, 'aa'), order(0, 4, 'zz')), 1, 'lamport dominates writer key')
  t.is(comparePersonalProgressOrder(order(0, 5, 'bb'), order(0, 5, 'cc')), -1, 'writer key breaks ties')
  t.is(comparePersonalProgressOrder(order(0, 5, 'bb'), order(0, 5, 'bb')), 0, 'identical triples compare equal')

  const stored = { stateKey: 'k', positionSec: 90, updatedAt: 10_000, order: order(0, 5, 'bb') }
  t.absent(mergePersonalProgress(stored, { stateKey: 'k', positionSec: 5, updatedAt: 99_999, order: order(0, 4, 'zz') }),
    'a stale write loses even with a newer wall-clock stamp')
  t.absent(mergePersonalProgress(stored, { stateKey: 'k', positionSec: 90, updatedAt: 10_000, order: order(0, 5, 'bb') }),
    'an exact replay — same triple, same content — is idempotent')
  t.is(mergePersonalProgress(stored, { stateKey: 'k', positionSec: 5, order: order(0, 5, 'cc') }).positionSec, 5,
    'the higher writer key wins the tie')
})

test('progress merge: an equal triple carrying different content is a conflict, not a replay', (t) => {
  // Two devices that stamp concurrently can mint the same triple. Treating that
  // as an idempotent replay drops both sides and leaves each device holding its
  // own record forever, so the content digest has to break the tie.
  const triple = order(0, 5, 'b'.repeat(64))
  const left = { stateKey: 'k', title: 'From A', positionSec: 90, updatedAt: 10_000, order: triple }
  const right = { stateKey: 'k', title: 'From B', positionSec: 5, updatedAt: 20_000, order: triple }

  const accepted = [mergePersonalProgress(left, right), mergePersonalProgress(right, left)].filter(Boolean)
  t.is(accepted.length, 1, 'exactly one side of the collision is accepted')

  const onA = mergePersonalProgress(left, right) || left
  const onB = mergePersonalProgress(right, left) || right
  t.is(onA.positionSec, onB.positionSec, 'both devices converge on the same position')
  t.is(onA.title, onB.title, 'and on the same metadata')

  t.absent(mergePersonalProgress(left, { ...left }), 'identical content under the same triple is still a replay')
})

test('progress merge: concurrent devices converge regardless of arrival order', async (t) => {
  await withStore({}, async (ps) => {
    const local = ps.localKeyHex
    // Arrival order is deliberately not the resolution order.
    await ps.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 50, durationSec: 100, order: order(0, 5, 'b'.repeat(64)) })
    await ps.putProgress({ identity: IDENTITY, positionSec: 10, order: order(0, 4, 'f'.repeat(64)) })
    let record = await ps.getProgress(STATE_KEY)
    t.is(record.positionSec, 50, 'a lower lamport never overwrites a higher one')
    t.is(record.order.writerKey, 'b'.repeat(64), 'winning writer key retained')

    await ps.putProgress({ identity: IDENTITY, positionSec: 70, order: order(0, 5, 'c'.repeat(64)) })
    record = await ps.getProgress(STATE_KEY)
    t.is(record.positionSec, 70, 'equal generation+lamport resolves on the higher writer key')
    t.is(record.title, 'S1E1', 'metadata carries across writes that omit it')

    // Idempotent replay: the very same op delivered twice. An equal triple
    // carrying *different* content is a conflict instead, resolved on content —
    // see the dedicated merge test above.
    const applied = await ps.getProgress(STATE_KEY)
    await ps._append({ type: 'put-progress', record: applied })
    t.alike(await ps.getProgress(STATE_KEY), applied, 'replaying an identical op changes nothing')

    // A locally stamped write observes the highest lamport it has seen.
    await ps.putProgress({ identity: IDENTITY, positionSec: 80 })
    record = await ps.getProgress(STATE_KEY)
    t.is(record.positionSec, 80, 'local write wins after stamping a fresh lamport')
    t.ok(record.order.lamport > 5, 'lamport advanced past every observed stamp')
    t.is(record.order.writerKey, local, 'local writes are stamped with this device writer key')
  })
})

test('progress: overlapping writes each mint their own Lamport stamp', async (t) => {
  await withStore({}, async (ps) => {
    // Both calls read the view, stamp and append while the other is in flight.
    await Promise.all([
      ps.logHistory({ identity: IDENTITY, title: 'S1E1', duration: 600, position: 100, timestamp: 1_000 }),
      ps.logHistory({ identity: IDENTITY, title: 'S1E1', duration: 600, position: 200, timestamp: 2_000 })
    ])

    const events = await ps.listHistory()
    const stamps = events.map((event) => event.order.lamport)
    t.is(events.length, 2, 'both writes were logged')
    t.is(new Set(stamps).size, 2, 'overlapping writes never share a Lamport stamp')

    const winner = events.find((event) => event.order.lamport === Math.max(...stamps))
    const record = await ps.getProgress(STATE_KEY)
    t.is(record.order.lamport, winner.order.lamport, 'the record carries the higher of the two stamps')
    t.is(record.positionSec, winner.position, 'the higher-stamped write applied instead of being dropped as a replay')

    // A position ping and a library toggle raised at the same moment.
    await Promise.all([
      ps.putProgress({ identity: IDENTITY, positionSec: 400 }),
      ps.setSaved(STATE_KEY, true)
    ])
    const merged = await ps.getProgress(STATE_KEY)
    t.is(merged.order.lamport, Math.max(...stamps) + 2, 'putProgress and setSaved each consumed a distinct stamp')
  })
})

test('progress merge: two real devices writing the same title converge on one record', async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-b-'))
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  const a = new PersonalStore(storeA, {})
  await a.ready()
  const b = new PersonalStore(storeB, { key: a.key })
  await b.ready()
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  await a.addWriter(b.localKeyHex, { deviceName: 'Device B' })
  t.ok(await b.waitForWritable(20_000), 'second device linked as a writer')

  // Both devices watch the same title while partitioned from each other's view.
  await a.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 120, durationSec: 600 })
  await b.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 240, durationSec: 600 })

  const converged = async () => {
    await a.update()
    await b.update()
    const left = await a.getProgress(STATE_KEY)
    const right = await b.getProgress(STATE_KEY)
    if (!left || !right) return null
    return comparePersonalProgressOrder(left.order, right.order) === 0 ? [left, right] : null
  }
  let pair = null
  for (let i = 0; i < 100 && !pair; i++) {
    pair = await converged()
    if (!pair) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.ok(pair, 'both devices resolve the same ordering triple')
  const [left, right] = pair
  t.is(left.positionSec, right.positionSec, 'both devices agree on the watch position')
  t.ok(left.order.writerKey === a.localKeyHex || left.order.writerKey === b.localKeyHex, 'the winner is one of the two devices')

  // The loser's next write observes the winning Lamport stamp and takes over.
  const loser = left.order.writerKey === a.localKeyHex ? b : a
  await loser.putProgress({ identity: IDENTITY, positionSec: 300 })
  await loser.update()
  const advanced = await loser.getProgress(STATE_KEY)
  t.is(advanced.positionSec, 300, 'the losing device can still advance the record')
  t.ok(advanced.order.lamport > left.order.lamport, 'its stamp is above the observed maximum')

  await b.close()
  await a.close()
  await storeA.close()
  await storeB.close()
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
})

test('progress merge: completion is monotonic inside a generation; a replay starts a new one', async (t) => {
  await withStore({}, async (ps) => {
    await ps.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 590, durationSec: 600, completed: true })
    t.ok((await ps.getProgress(STATE_KEY)).completed, 'completion recorded')

    await ps.putProgress({ identity: IDENTITY, positionSec: 12, completed: false })
    let record = await ps.getProgress(STATE_KEY)
    t.ok(record.completed, 'a later low-position ping cannot un-complete the same generation')
    t.is(record.positionSec, 12, 'position still tracks the newest write')
    t.is(record.order.playbackGeneration, 0, 'generation unchanged by an ordinary ping')

    await ps.putProgress({ identity: IDENTITY, replay: true })
    record = await ps.getProgress(STATE_KEY)
    t.is(record.order.playbackGeneration, 1, 'an explicit replay bumps to a strictly higher generation')
    t.absent(record.completed, 'the new generation resets completion')
    t.is(record.positionSec, 0, 'the new generation resets position')
    t.is(record.title, 'S1E1', 'title survives a replay')

    // A late write from the previous generation must not resurrect old state.
    await ps.putProgress({ identity: IDENTITY, positionSec: 599, completed: true, order: order(0, 9_999, 'f'.repeat(64)) })
    record = await ps.getProgress(STATE_KEY)
    t.is(record.order.playbackGeneration, 1, 'the older generation loses no matter how high its lamport')
    t.absent(record.completed, 'stale generation cannot re-complete the title')
  })
})

test('progress: saved library flag survives progress updates and replays', async (t) => {
  await withStore({}, async (ps) => {
    // Saving a title that was never played creates the record from the state key.
    await ps.setSaved(STATE_KEY, true, { title: 'S1E1' })
    let record = await ps.getProgress(STATE_KEY)
    t.ok(record.saved, 'saved flag set without prior playback')
    t.alike(record.identity, IDENTITY, 'identity reconstructed from the state key')
    t.is((await ps.listProgress({ savedOnly: true })).length, 1, 'saved records are filterable')

    await ps.putProgress({ identity: IDENTITY, positionSec: 30, durationSec: 600 })
    t.ok((await ps.getProgress(STATE_KEY)).saved, 'a position update does not clear the library flag')

    await ps.setSaved(STATE_KEY, false)
    record = await ps.getProgress(STATE_KEY)
    t.absent(record.saved, 'unsaving works')
    t.is(record.positionSec, 30, 'unsaving preserves watch position')
    t.is((await ps.listProgress({ savedOnly: true })).length, 0, 'no saved records remain')
  })
})

test('progress: tombstones are retained for ordering but hidden from every read', async (t) => {
  await withStore({}, async (ps) => {
    await ps.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 120, durationSec: 600 })
    t.ok(await ps.deleteProgress(STATE_KEY), 'delete reports success')

    t.absent(await ps.getProgress(STATE_KEY), 'tombstoned record hidden from getProgress')
    t.is((await ps.listProgress()).length, 0, 'tombstoned record hidden from listProgress')
    t.is((await ps.listResume()).length, 0, 'tombstoned record hidden from continue-watching')
    t.absent(await ps.getResume(STATE_KEY), 'tombstoned record hidden from getResume')

    const retained = await ps.listProgress({ includeTombstoned: true })
    t.is(retained.length, 1, 'the record itself is retained for ordering')
    t.ok(retained[0].order.tombstone, 'retained record is flagged as a tombstone')

    // A slower device replaying its pre-delete write must not resurrect the title.
    await ps.putProgress({ identity: IDENTITY, positionSec: 200, order: order(0, 1, 'a'.repeat(64)) })
    t.absent(await ps.getProgress(STATE_KEY), 'a stale write cannot resurrect a tombstoned record')

    t.absent(await ps.deleteProgress('never-watched'), 'deleting an unknown state key is a no-op')
  })
})

test('progress: a delete is sticky — a same-generation write cannot resurrect it', async (t) => {
  await withStore({}, async (ps) => {
    await ps.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 120, durationSec: 600 })
    t.ok(await ps.deleteProgress(STATE_KEY), 'record deleted')

    // The player keeps pinging position for the title the user just removed.
    await ps.putProgress({ identity: IDENTITY, positionSec: 130 })
    t.absent(await ps.getProgress(STATE_KEY), 'an ordinary ping does not revive the deleted record')
    t.is((await ps.listResume()).length, 0, 'the deleted title stays out of continue-watching')

    const [retained] = await ps.listProgress({ includeTombstoned: true })
    t.ok(retained.order.tombstone, 'the tombstone carried forward instead of being reset to false')
    t.is(retained.positionSec, 130, 'the write still applied — it simply stayed deleted')

    // Playing the title again is a strictly higher generation, and does revive it.
    await ps.putProgress({ identity: IDENTITY, replay: true, positionSec: 4 })
    const revived = await ps.getProgress(STATE_KEY)
    t.ok(revived, 'a new playback generation revives the record')
    t.is(revived.order.playbackGeneration, 1, 'the revival is a new generation')
    t.is(revived.title, 'S1E1', 'metadata survives the revival')

    // So does an explicit un-delete, without waiting for a replay.
    await ps.deleteProgress(STATE_KEY)
    t.absent(await ps.getProgress(STATE_KEY), 'deleted again')
    await ps.setSaved(STATE_KEY, true)
    t.ok(await ps.getProgress(STATE_KEY), 'an explicit tombstone:false brings it back')
  })
})

test('progress: retention caps are bounded and pruned deterministically (oldest first)', async (t) => {
  await withStore({ progressLimit: 3, historyLimit: 2 }, async (ps) => {
    t.alike(ps.retentionLimits, { progress: 3, history: 2 }, 'caps are explicit')

    for (let i = 1; i <= 5; i++) {
      await ps.putProgress({ videoKey: `vk${i}`, positionSec: i, updatedAt: i * 1000 })
    }
    const kept = (await ps.listProgress({ includeTombstoned: true })).map((r) => r.stateKey).sort()
    t.is(kept.length, 3, 'progress records are capped')
    t.alike(kept, ['vk3', 'vk4', 'vk5'], 'the oldest updatedAt records are pruned first')

    for (let i = 1; i <= 4; i++) {
      await ps.logHistory({ videoKey: `hk${i}`, title: `Ep ${i}`, position: i, timestamp: 10_000 + i })
    }
    const history = await ps.listHistory({ limit: 50 })
    t.is(history.length, 2, 'history events are capped')
    t.alike(history.map((h) => h.videoKey), ['hk4', 'hk3'], 'newest events are kept, oldest pruned')
  })
})

test('progress: retention prunes tombstones first and never evicts the record just written', async (t) => {
  await withStore({ progressLimit: 2 }, async (ps) => {
    await ps.putProgress({ videoKey: 'dead', positionSec: 10, updatedAt: 5_000 })
    await ps.deleteProgress('dead')
    await ps.putProgress({ videoKey: 'live-old', positionSec: 20, updatedAt: 1_000 })
    await ps.putProgress({ videoKey: 'fresh', positionSec: 30, updatedAt: 9_000 })

    const kept = (await ps.listProgress({ includeTombstoned: true })).map((r) => r.stateKey).sort()
    t.alike(kept, ['fresh', 'live-old'], 'the tombstone is dropped before either live record')

    // The oldest record in the store is now the one being written; it must survive.
    await ps.putProgress({ videoKey: 'ancient', positionSec: 40, updatedAt: 1 })
    const after = (await ps.listProgress({ includeTombstoned: true })).map((r) => r.stateKey).sort()
    t.alike(after, ['ancient', 'fresh'], 'the new record survives; the oldest survivor is pruned instead')
  })
})

test('progress: logHistory writes the history event and the canonical progress record', async (t) => {
  await withStore({}, async (ps) => {
    const eventId = await ps.logHistory({
      identity: IDENTITY,
      channelKey: 'c'.repeat(64),
      videoId: 'v1',
      videoKey: 'legacy-vk',
      title: 'S1E1',
      duration: 600,
      position: 300,
      saved: true,
      timestamp: 20_000
    })
    t.ok(eventId, 'event id returned for existing callers')

    const [event] = await ps.listHistory()
    t.is(event.eventId, eventId, 'history event stored')
    t.alike(event.identity, IDENTITY, 'history event carries the media identity')
    t.ok(event.saved, 'history event carries the library flag')
    t.is(event.order.writerKey, ps.localKeyHex, 'history event carries the ordering triple')

    const record = await ps.getProgress(STATE_KEY)
    t.is(record.positionSec, 300, 'progress record written from the same op')
    t.is(record.position, 300, 'legacy position field mirrored')
    t.is(record.durationSec, 600, 'duration recorded')
    t.is(record.videoKey, 'legacy-vk', 'legacy coordinates retained on the record')
    t.ok(record.saved, 'library flag persisted')

    const resume = await ps.getResume(STATE_KEY)
    t.is(resume.videoKey, 'legacy-vk', 'resume entry keeps the required videoKey field')
    t.alike(resume.identity, IDENTITY, 'resume entry carries identity')
    t.ok(resume.saved, 'resume entry carries the saved flag')
    t.is(resume.order.lamport, record.order.lamport, 'resume entry carries the ordering triple')

    // Identity-only titles still satisfy the required resume `videoKey` field.
    await ps.putProgress({ identity: { entityRef: 'entity:tt2' }, positionSec: 5 })
    const entry = (await ps.listResume()).find((e) => e.stateKey === 'entity:tt2||')
    t.is(entry.videoKey, 'entity:tt2||', 'identity-only entries fall back to the state key')
  })
})

test('progress: legacy resume rows migrate, and the source survives until the record is durable', async (t) => {
  await withStore({}, async (ps) => {
    // A pre-progress `log-history` op, exactly as older devices persisted it.
    await ps._append({
      type: 'log-history',
      eventId: 'legacy-event',
      videoKey: 'legacy-vk',
      channelKey: 'c'.repeat(64),
      videoId: 'v1',
      title: 'Legacy Ep',
      duration: 120,
      position: 42,
      timestamp: 1000
    })
    t.is((await ps.getResume('legacy-vk')).position, 42, 'legacy resume row is readable before migration')
    t.is((await ps.listResume()).length, 1, 'legacy rows appear in continue-watching before migration')
    t.is((await ps.listProgress()).length, 0, 'no progress record yet')

    // Durability gate: pretend the encrypted record does not read back.
    const readRecord = ps._readProgressRecord.bind(ps)
    ps._readProgressRecord = async () => null
    const failed = await ps.migrateLegacyResume()
    ps._readProgressRecord = readRecord
    t.is(failed.migrated, 0, 'nothing is reported as migrated')
    t.is(failed.retained, 1, 'the legacy row is retained when the record does not read back')
    t.is((await ps.getResume('legacy-vk')).position, 42, 'legacy watch state is still reachable')

    const ok = await ps.migrateLegacyResume()
    t.is(ok.migrated, 1, 'the row migrates once the record reads back')
    t.is(ok.retained, 0, 'the legacy row is dropped only then')

    const record = await ps.getProgress('legacy-vk')
    t.is(record.positionSec, 42, 'position carried into the progress record')
    t.is(record.channelKey, 'c'.repeat(64), 'legacy coordinates carried')
    t.is(record.order.writerKey, ps.localKeyHex, 'migrated record is stamped by this device')
    t.is((await ps.listResume()).length, 1, 'continue-watching is not duplicated after migration')
    t.is((await ps.getResume('legacy-vk')).position, 42, 'resume still resolves through the progress record')
  })
})

test('device invites: fresh single-use mint, five-minute clamp, replay and expiry rejected', async (t) => {
  await withStore({}, async (ps) => {
    t.is(PERSONAL_INVITE_MAX_TTL_MS, 5 * 60 * 1000, 'invites expire within five minutes')

    const first = await ps.createInvite({ expiresInMs: 60_000 })
    const second = await ps.createInvite({ expiresInMs: 60_000 })
    t.not(first.inviteCode, second.inviteCode, 'every create mints a fresh invite')
    t.not(first.idHex, second.idHex, 'invite ids are distinct')
    t.ok(first.expiresAt - Date.now() <= 60_000, 'requested expiry honored')

    const clamped = await ps.createInvite({ expiresInMs: 60 * 60 * 1000 })
    t.ok(clamped.expiresAt - Date.now() <= PERSONAL_INVITE_MAX_TTL_MS, 'a longer request is clamped, never honored')
    const defaulted = await ps.createInvite({})
    t.ok(defaulted.expiresAt - Date.now() <= PERSONAL_INVITE_MAX_TTL_MS, 'the default expiry is also bounded')

    t.ok(await ps._consumeInvite(second.idHex), 'an unexpired invite can be claimed once')
    t.absent(await ps._consumeInvite(second.idHex), 'a replayed redemption is rejected')
    t.absent(await ps._consumeInvite('f'.repeat(64)), 'an unknown invite id is rejected')

    // Concurrent redemption: the consume op is ordered, so exactly one wins.
    const claims = await Promise.all([ps._consumeInvite(first.idHex), ps._consumeInvite(first.idHex)])
    t.is(claims.filter(Boolean).length, 1, 'exactly one of two concurrent claims succeeds')

    // Expiry is enforced from the op timestamp, so every device agrees.
    const expiredId = 'a'.repeat(64)
    await ps._append({
      type: 'put-invite',
      invite: {
        idHex: expiredId,
        inviteZ32: 'expired',
        publicKeyHex: 'b'.repeat(64),
        createdAt: Date.now() - 10 * 60 * 1000,
        expiresAt: Date.now() - 1000
      }
    })
    t.absent(await ps._consumeInvite(expiredId), 'an expired invite is rejected')
    await ps._append({ type: 'consume-invite', idHex: expiredId, at: Date.now(), consumeId: 'forced', writerKey: 'x' })
    const expired = (await ps.listInvites()).find((i) => i.idHex === expiredId)
    t.is(expired.consumedAt, 0, 'a forced consume of an expired invite is a no-op in apply')

    // Consumed and expired invites are garbage-collected, invites never leak into settings.
    await ps.createInvite({})
    const ids = (await ps.listInvites()).map((i) => i.idHex)
    t.absent(ids.includes(second.idHex), 'consumed invites are pruned')
    t.absent(ids.includes(expiredId), 'expired invites are pruned')
    t.alike(await ps.getSettings(), {}, 'invites are not stored as settings')
  })
})

/** Minimal Hyperswarm stand-in: records joins and leaves, never touches the network. */
function fakeSwarm () {
  const emptyQuery = { destroy () {}, async * [Symbol.asyncIterator] () {} }
  return {
    connections: [],
    joined: [],
    left: [],
    discoveries: [],
    dht: { on () {}, off () {}, removeListener () {}, lookup: () => emptyQuery },
    on () {},
    off () {},
    removeListener () {},
    join (topic) {
      this.joined.push(topic)
      const discovery = { destroyed: false, async flushed () {}, async destroy () { this.destroyed = true } }
      this.discoveries.push(discovery)
      return discovery
    },
    async leave (topic) { this.left.push(topic) }
  }
}

test('device invites: stale invites are swept on pairing setup and after a redemption', async (t) => {
  await withStore({}, async (ps) => {
    const swarm = fakeSwarm()
    const topic = ps.discoveryKey
    const expiredInvite = (idHex) => ps._append({
      type: 'put-invite',
      invite: {
        idHex,
        inviteZ32: 'stale',
        publicKeyHex: 'b'.repeat(64),
        createdAt: Date.now() - 10 * 60 * 1000,
        expiresAt: Date.now() - 1000
      }
    })

    // Minted before the app was last closed, and expired while it was offline.
    await expiredInvite('a'.repeat(64))
    t.is((await ps.listInvites()).length, 1, 'the expired invite outlives the session that minted it')

    await ps.setupPairing(swarm)
    t.is((await ps.listInvites()).length, 0, 'pairing setup sweeps invites that expired offline')
    t.ok(swarm.joined.length >= 1, 'the store joined its discovery topic')

    // Redeem a fresh invite while another one rots beside it.
    const fresh = await ps.createInvite({})
    await expiredInvite('c'.repeat(64))
    t.is((await ps.listInvites()).length, 2, 'both invites are stored before the redemption')

    // A fabricated writer key would poison the autobase, so only that call is stubbed.
    const addWriter = ps.addWriter.bind(ps)
    ps.addWriter = async () => {}
    let confirmed = null
    try {
      await ps.pairingMember.onadd({
        inviteId: Buffer.from(fresh.idHex, 'hex'),
        open: () => encodePersonalPairingUserData('d'.repeat(64), 'Laptop'),
        confirm: (payload) => { confirmed = payload }
      })
    } finally {
      ps.addWriter = addWriter
    }
    t.ok(confirmed, 'the joining device was confirmed')
    t.alike(await ps.listInvites(), [], 'the redeemed invite and the stale one are both gone')

    // The handler runs in scope of the keychain secret, so it logs the message only.
    const logged = []
    const realError = console.error
    console.error = (...args) => logged.push(args)
    try {
      await ps.pairingMember.onadd({ get inviteId () { throw new Error('boom') } })
    } finally {
      console.error = realError
    }
    t.is(logged.length, 1, 'the pairing failure was logged')
    t.ok(logged[0].every((arg) => typeof arg === 'string'), 'nothing but strings reaches the log')
    t.ok(logged[0].join(' ').includes('boom'), 'the failure message is preserved')

    await ps.close()
    t.ok(swarm.discoveries.length >= 1, 'discovery sessions were created')
    t.ok(swarm.discoveries.every((d) => d.destroyed), 'every discovery session was destroyed, not close()d')
    t.alike(swarm.left, [topic], 'the swarm left the topic so an abandoned epoch stops announcing')
  })
})

test('epoch rotation: exportState/importState carry bounded state without the secret, invites or writers', async (t) => {
  const { store, dir } = tmpStore()
  await store.ready()
  const secret = generateSecret()
  const source = new PersonalStore(store, { namespace: 'epoch-old', secret })
  await source.ready()

  await source.subscribe('a'.repeat(64), { name: 'Chan' })
  const playlistId = await source.createPlaylist({ name: 'Watch Later' })
  await source.addToPlaylist(playlistId, { channelKey: 'c'.repeat(64), videoId: 'v1' })
  await source.setSetting('theme', 'dark')
  await source.logHistory({ identity: IDENTITY, title: 'S1E1', videoKey: 'legacy-vk', duration: 600, position: 300, saved: true, timestamp: 30_000 })
  await source.putProgress({ videoKey: 'gone', positionSec: 10 })
  await source.deleteProgress('gone')
  const invite = await source.createInvite({})

  const state = await source.exportState()
  const serialized = JSON.stringify(state)
  t.is(state.version, PERSONAL_STATE_EXPORT_VERSION, 'export is versioned')
  t.absent(serialized.includes(source.secretHex), 'the keychain secret is never exported')
  t.absent(serialized.includes(invite.inviteCode), 'pairing invites are never exported')
  t.absent(serialized.includes(invite.idHex), 'invite ids are never exported')
  t.is(state.progress.length, 1, 'tombstoned records are not carried into a new epoch')
  t.ok(Array.isArray(state.devices), 'a non-secret device roster is reported')

  const target = new PersonalStore(store, { namespace: 'epoch-new', secret: generateSecret() })
  await target.ready()
  t.not(target.keyHex, source.keyHex, 'the new epoch is a different store')

  const summary = await target.importState({ ...state, devices: [{ keyHex: 'd'.repeat(64), deviceName: 'Old Phone' }] })
  t.alike(summary.droppedDevices, ['d'.repeat(64)], 'revoked devices are reported, not restored')
  t.is((await target.listWriters()).length, 0, 'no device is granted write access by an import; retained devices must re-pair')
  t.is((await target.listInvites()).length, 0, 'invites do not cross the epoch')

  t.is((await target.listSubscriptions())[0].name, 'Chan', 'subscriptions restored')
  t.is((await target.listPlaylists())[0].name, 'Watch Later', 'playlists restored')
  t.is((await target.listPlaylistItems(playlistId)).length, 1, 'playlist items restored')
  t.is(await target.getSetting('theme'), 'dark', 'settings restored')
  t.is((await target.listHistory()).length, 1, 'history restored')

  const record = await target.getProgress(STATE_KEY)
  t.is(record.positionSec, 300, 'watch position restored')
  t.ok(record.saved, 'library flag restored')
  t.alike(record.identity, IDENTITY, 'media identity restored')
  t.alike(record.order, state.progress[0].order, 'the ordering triple is preserved verbatim across the epoch')
  t.absent(await target.getProgress('gone'), 'deleted titles stay deleted')

  // The new epoch keeps ordering monotonic: a local write beats the imported triple.
  await target.putProgress({ identity: IDENTITY, positionSec: 320 })
  const advanced = await target.getProgress(STATE_KEY)
  t.is(advanced.positionSec, 320, 'local writes still win in the new epoch')
  t.ok(advanced.order.lamport > record.order.lamport, 'the Lamport clock resumes above the imported maximum')

  await target.close()
  await source.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('epoch rotation: a frozen store refuses writes, keeps reads, and resumes after unfreeze', async (t) => {
  await withStore({}, async (ps) => {
    await ps.setSetting('theme', 'dark')
    await ps.putProgress({ identity: IDENTITY, title: 'S1E1', positionSec: 30 })
    t.absent(ps.frozen, 'a store starts unfrozen')

    ps.freeze()
    t.ok(ps.frozen, 'freeze flips the getter')

    const reject = (promise) => promise.then(() => null, (err) => err)
    const single = await reject(ps.setSetting('theme', 'light'))
    t.is(single?.code, 'PERSONAL_STORE_FROZEN', 'a single append rejects with the documented code')
    t.is(single.message, 'personal-store-rotating', 'and carries the default reason as its message')

    const batch = await reject(ps.importState({}))
    t.is(batch?.code, 'PERSONAL_STORE_FROZEN', 'a batch append rejects too, even with nothing to write')

    // Reads stay open: a rotation has to export state while the store is frozen.
    t.is(await ps.getSetting('theme'), 'dark', 'the refused write never landed')
    t.is((await ps.getProgress(STATE_KEY)).positionSec, 30, 'progress is still readable')
    t.is((await ps.exportState()).progress.length, 1, 'exportState works while frozen')

    ps.freeze('epoch-rotating')
    const custom = await reject(ps.subscribe('a'.repeat(64), { name: 'Chan' }))
    t.is(custom.message, 'epoch-rotating', 'the reason is caller-supplied')
    t.is(custom.code, 'PERSONAL_STORE_FROZEN', 'the code is stable across reasons')

    ps.unfreeze()
    t.absent(ps.frozen, 'unfreeze clears it')
    await ps.setSetting('theme', 'light')
    t.is(await ps.getSetting('theme'), 'light', 'the pending write replays against the unfrozen store')
  })
})
