// Rebuilds a node's channel view from its oplog with the current apply. Autobee keeps the view's position as
// user data on the local writer core (`autobee/head`); clearing it boots the next open at genesis, which replays
// every writer offline through apply onto the same system and view cores (append-only: the old tree's blocks stay,
// nothing is truncated, and the signed oplog is never written except the one `owner` op below). The owner's next
// stamp must point at the rebuilt tree, or new followers keep landing on the old one, so the owner appends one
// `owner` op (a no-op for apply) once the replay is done. Run with the relay stopped: bin/rebuild-view.js.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import b4a from 'b4a'
import Autobee from 'autobee'
import Corestore from 'corestore'
import CoreStorage from 'hypercore-storage'
import { makeApply, decodeOp } from './index.js'
import { deriveIdentity } from './mnemonic.js'

const HEX64 = /^[0-9a-f]{64}$/
const isSystemKey = k => k.startsWith('meta/') || k.startsWith('writer/') || k.startsWith('revoked/') || k.startsWith('source/') || k.startsWith('peer/')

export async function rebuildView ({ storage, channel = null, check = false, rollback = false, log = () => {} }) {
  const identity = JSON.parse(readFileSync(join(storage, 'identity.json'), 'utf8'))
  const vault = identity.mnemonic ? deriveIdentity(identity.mnemonic) : null
  const channelHex = String(channel || identity.founded || vault?.channelKey || '').toLowerCase()
  if (!HEX64.test(channelHex)) throw new Error('Channel key unknown: pass it as the second argument')
  const owner = Boolean(vault && vault.channelKey === channelHex)
  const backupFile = join(storage, 'rebuild-view.backup.json')
  const store = new Corestore(new CoreStorage(join(storage, 'corestore')))
  await store.ready()
  const ns = store.namespace('tracker')
  try {
    const bootstrap = ns.get({ key: b4a.from(channelHex, 'hex'), active: false })
    await bootstrap.ready()
    const localKey = owner ? bootstrap.key : await bootstrap.getUserData('autobee/local')
    if (!localKey) throw new Error('No local writer recorded for this channel in this storage')
    const local = owner ? bootstrap : ns.get({ key: localKey, active: false })
    await local.ready()
    const head = await local.getUserData('autobee/head')
    const before = { channel: channelHex, owner, local: b4a.toString(local.key, 'hex'), oplogLength: local.length, head: head ? b4a.toString(head, 'hex') : null }
    // only the channel's own bootstrap writer stamps views followers trust; a founder-key relay owns the channel without a matching vault
    const stamps = before.local === channelHex
    before.stamps = stamps
    if (rollback) {
      // the old tree's blocks are still in the cores: pointing the boot record back at it restores the old
      // view, with any oplog node appended since (the stamp op included) applied on top. The oplog is kept.
      const saved = JSON.parse(readFileSync(backupFile, 'utf8'))
      if (saved.local !== before.local || !saved.head) throw new Error(`${backupFile} does not belong to this writer`)
      await local.setUserData('autobee/head', b4a.from(saved.head, 'hex'))
      log({ msg: 'boot record restored', ...before, head: saved.head })
      await local.close()
      return { ...before, head: saved.head }
    }
    log({ msg: check ? 'rebuild-view check' : 'rebuild-view start', ...before })
    await local.close()
    if (!owner) await bootstrap.close()

    // Autobee closes the store session it is given, so every open gets its own
    const open = async () => {
      const bee = new Autobee(store.namespace('tracker'), owner ? null : b4a.from(channelHex, 'hex'), {
        ...(owner ? { keyPair: vault.genesisKeyPair } : {}),
        apply: makeApply(() => channelHex),
        optimistic: true,
        // a replay must never land on this node's own stale stamp
        fastForward: false
      })
      await bee.ready()
      if (b4a.toString(bee.local.key, 'hex') !== before.local) throw new Error('Opened a different local writer than the boot record belongs to')
      return bee
    }

    // the view as it is: its announce keys must all survive the rebuild, or the replay did not finish
    let bee = await open()
    const old = await summarize(bee)
    old.writable = bee.writable
    log({ msg: 'view before', ...old, announceKeys: undefined, flushes: old.flushes })
    await bee.close()
    if (check) return { ...before, ...old, announceKeys: undefined, oplogLengthAfter: before.oplogLength }
    if (stamps && !old.writable) throw new Error('This node must stamp the rebuilt view but cannot write to the channel; nothing was changed')

    writeFileSync(backupFile, JSON.stringify({ at: new Date().toISOString(), ...before }, null, 2), { mode: 0o600 })
    const cleared = ns.get({ key: b4a.from(before.local, 'hex'), active: false })
    await cleared.ready()
    await cleared.setUserData('autobee/head', null)
    await cleared.close()
    log({ msg: 'boot record cleared', backupFile })

    bee = await open()
    const progress = setInterval(() => log({ msg: 'replaying', flushes: bee.flushes, oplogLength: bee.local.length }), 5000)
    try {
      // a link to a writer not opened yet ends a drain early, so the replay is done only once nothing has
      // moved for a while; everything is local, so a real stall is a missing block and fails the guard below
      let flushes = -1
      let quiet = 0
      while (quiet < 12) {
        await bee.update()
        if (bee.flushes === flushes) quiet++
        else { quiet = 0; flushes = bee.flushes }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } finally {
      clearInterval(progress)
    }
    const rebuilt = await summarize(bee)
    log({ msg: 'view rebuilt', ...rebuilt, announceKeys: undefined })
    if (bee.local.length !== before.oplogLength) throw new Error(`The replay appended to the oplog (${before.oplogLength} -> ${bee.local.length}); roll back`)
    const missing = [...old.announceKeys].filter(k => !rebuilt.announceKeys.has(k))
    if (missing.length) throw new Error(`The rebuilt view lacks ${missing.length} announce keys the old one had (first: ${missing[0]}); the replay is incomplete, roll back`)
    if (stamps) {
      // an op type no apply version accepts: it changes nothing, but its flush stamps the rebuilt view
      await bee.append(b4a.from(JSON.stringify({ type: 'stamp' })))
      await bee.updated()
      if (bee.local.length !== before.oplogLength + 1) throw new Error(`Expected one stamp node, oplog went ${before.oplogLength} -> ${bee.local.length}`)
      log({ msg: 'owner stamped the rebuilt view', oplogLength: bee.local.length, views: viewsOf(bee) })
    }
    await bee.close()
    return { ...before, ...rebuilt, announceKeys: undefined, oplogLengthAfter: before.oplogLength + (stamps ? 1 : 0) }
  } finally {
    await store.close()
  }
}

// `announceKeys` counts view keys (one per announce sub); the catalog dedupes them by id, so `/v1/entries`
// reports fewer. `flushes` is Autobee's own counter and is not a node count.
async function summarize (bee) {
  const announceKeys = new Set()
  let writers = 0
  let peers = 0
  let keys = 0
  for await (const node of bee.view.createReadStream()) {
    keys++
    const k = b4a.toString(node.key)
    if (k.startsWith('writer/')) writers++
    else if (k.startsWith('peer/')) peers++
    else if (!isSystemKey(k) && decodeOp(node.value)?.type === 'announce') announceKeys.add(k)
  }
  return { flushes: bee.flushes, keys, announces: announceKeys.size, writers, peers, views: viewsOf(bee), announceKeys }
}

function viewsOf (bee) {
  return bee.views().slice(0, 2).map(v => ({ key: b4a.toString(v.key, 'hex'), length: v.length }))
}
