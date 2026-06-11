/**
 * PersonalStore multi-device sync harness.
 *
 * Proves that two devices (separate corestores) sharing one personal store
 * key can BOTH write and that their data converges — i.e. real multi-writer,
 * which HyperDB.bee (single-writer) cannot do. Covers subscriptions,
 * playlists, watch history, settings, and concurrent-write convergence.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import { PersonalStore } from '../src/personal/personal-store.js'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for ' + label)
    await sleep(intervalMs)
  }
}

function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg) }

async function main() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-b-'))

  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  // Device A creates the personal store.
  const a = new PersonalStore(storeA, {})
  await a.ready()
  assert(a.writable, 'A should be writable as creator')

  // Device B opens the same store by key (read-only until added as writer).
  const b = new PersonalStore(storeB, { key: a.key })
  await b.ready()

  // Wire replication between the two corestores.
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  // A grants B write access (device linking).
  await a.addWriter(b.localKeyHex, { deviceName: 'Device B' })
  const becameWritable = await b.waitForWritable(20000)
  assert(becameWritable, 'B should become writable after addWriter')
  console.log('[OK] device B linked as writer')

  // --- Subscriptions: A writes, B sees it ---
  await a.subscribe('a'.repeat(64), { name: 'Cool Channel' })
  await waitFor(async () => {
    await b.update()
    const subs = await b.listSubscriptions()
    return subs.find((s) => s.name === 'Cool Channel') || null
  }, { label: 'subscription replicate A->B' })
  console.log('[OK] subscription A -> B')

  // --- Playlists: B creates, A sees it (write from the *paired* device) ---
  const plId = await b.createPlaylist({ name: 'Watch Later' })
  await b.addToPlaylist(plId, { channelKey: 'c'.repeat(64), videoId: 'vid-1' })
  await waitFor(async () => {
    await a.update()
    const pls = await a.listPlaylists()
    if (!pls.find((p) => p.name === 'Watch Later')) return null
    const items = await a.listPlaylistItems(plId)
    return items.length === 1 ? items : null
  }, { label: 'playlist replicate B->A' })
  console.log('[OK] playlist + item B -> A')

  // --- Watch history + resume ---
  await a.logHistory({ channelKey: 'c'.repeat(64), videoId: 'vid-1', videoKey: 'vk-1', title: 'Ep 1', duration: 600, position: 120 })
  await waitFor(async () => {
    await b.update()
    const resume = await b.getResume('vk-1')
    return resume && resume.position === 120 ? resume : null
  }, { label: 'history/resume replicate A->B' })
  const hist = await b.listHistory()
  assert(hist.length >= 1 && hist[0].videoKey === 'vk-1', 'history newest-first contains vk-1')
  console.log('[OK] watch history + resume A -> B')

  // --- Settings ---
  await b.setSetting('theme', 'dark')
  await waitFor(async () => {
    await a.update()
    return (await a.getSetting('theme')) === 'dark' ? true : null
  }, { label: 'setting replicate B->A' })
  console.log('[OK] setting B -> A')

  // --- Concurrent-write convergence (the multi-writer acid test) ---
  await Promise.all([
    a.setSetting('playbackRate', '1.5'),
    b.setSetting('playbackRate', '2.0')
  ])
  const converged = await waitFor(async () => {
    await a.update()
    await b.update()
    const va = await a.getSetting('playbackRate')
    const vb = await b.getSetting('playbackRate')
    return va !== undefined && va === vb ? va : null
  }, { label: 'concurrent-write convergence', timeoutMs: 25000, intervalMs: 200 })
  console.log('[OK] concurrent writes converged to:', converged)

  await a.close()
  await b.close()
  s1.destroy()
  s2.destroy()
  await storeA.close()
  await storeB.close()
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })

  console.log('\n[PASS] PersonalStore multi-writer harness passed')
}

main().catch((err) => {
  console.error('\n[FAIL] PersonalStore harness failed:', err)
  process.exitCode = 1
})
