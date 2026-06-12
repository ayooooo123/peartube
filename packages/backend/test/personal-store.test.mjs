import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import { PersonalStore } from '../src/personal/personal-store.js'

function tmpStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-test-'))
  const store = new Corestore(dir)
  return { store, dir }
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
