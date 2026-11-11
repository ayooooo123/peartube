import Autobee from 'autobee'
import ProtomuxWakeup from 'protomux-wakeup'
import b4a from 'b4a'
import { makeApply, makeIsTrusted } from '../apply.js'
import { HEX64, ROLES, cleanText, decodeOp } from '../protocol.js'

// Reads take a tracker's view as far as Autobee has applied it, waiting at most a second for more. A fresh
// joiner of a large tracker takes minutes to catch up (V8 on a Mac: about two; a phone's QuickJS: far longer),
// and starting, listing and playback must not wait that out: the list fills in as it applies, and Autobee's
// update events redraw it. Writes and garbage collection still wait for the whole update.
export function applied (bee) {
  const update = bee.update()
  update.catch(() => {})
  let timer
  const wait = new Promise(resolve => { timer = setTimeout(resolve, 1000) })
  return Promise.race([update, wait]).finally(() => clearTimeout(timer))
}

export async function createChannel (ctx) {
  const {
    tracker: trackerOpt = null,
    join: joinOpt = false,
    sources: initialSources = [],
    worklet: isWorklet = false
  } = ctx.opts

  const wakeup = new ProtomuxWakeup()
  let viewEpoch = 1

  let targetKey = String(trackerOpt || '').trim().toLowerCase() || null
  if (targetKey && !HEX64.test(targetKey)) throw new Error('Channel key must be 64 hex characters')
  if (joinOpt && ctx.identity.idVault && !targetKey) targetKey = ctx.identity.idVault.channelKey

  const chNs = ctx.storage.store.namespace('tracker')
  const probeLocal = chNs.get({ name: 'local', active: false })
  await probeLocal.ready()
  const hasPreMnemonicLocal = probeLocal.length > 0
  await probeLocal.close()

  let founderKeyPair = null
  if (!targetKey) {
    if (hasPreMnemonicLocal && !ctx.identity.foundedKey()) {
      ctx.identity.ensureVault()
    } else {
      ctx.identity.ensureVault()
      if (ctx.identity.foundedKey() && ctx.identity.foundedKey() !== ctx.identity.idVault.channelKey) {
        targetKey = ctx.identity.idVault.channelKey
      } else {
        founderKeyPair = ctx.identity.idVault.genesisKeyPair
      }
    }
  } else if (!ctx.identity.idVault && !joinOpt) {
    ctx.identity.ensureVault()
  }

  const writerCores = new Map()
  let channel = null
  let writerSync = Promise.resolve()
  const primaryApply = makeApply(() => b4a.toString(channel.key, 'hex'))
  // Fast-forward lands only on views stamped by the channel owner (makeIsTrusted); every other writer's
  // nodes still go through apply here. A landing needs a connected peer that holds the owner's own
  // system and view cores: the owner itself, or a node that landed on them before. A landing leaves
  // those cores sparse here, so keep them whole and live: this node can then hand the landing on
  // when the owner is unreachable, and never stalls on a block only the owner holds.
  // Landings are held per channel. A channel that lands again on new keys closes its old cores. A sleeping
  // channel keeps its landed cores open only until they are whole, so this node can still hand the landing
  // on, then closes them; it reopens them when it wakes. An unfollowed channel has them purged.
  // `landedCores` is the flat view of open sessions the relay seeds from and the node closes wholesale.
  const landedCores = new Map() // core hex -> open session
  const landedByChannel = new Map() // channel hex -> Map<'system'|'view', { hex, held }>
  function heldElsewhere (hex, channelHex) {
    for (const [ch, recs] of landedByChannel) {
      if (ch === channelHex) continue
      for (const rec of recs.values()) if (rec.held && rec.hex === hex) return true
    }
    return false
  }
  function openLanding (hex) {
    if (landedCores.has(hex)) return
    const core = ctx.storage.store.get({ key: b4a.from(hex, 'hex') })
    landedCores.set(hex, core)
    core.ready().then(() => core.download({ start: 0, end: -1 })).catch(() => {})
  }
  function dropLanding (hex) {
    const core = landedCores.get(hex)
    if (!core) return
    landedCores.delete(hex)
    return core.close().catch(() => {})
  }
  function closeWhenWhole (hex) {
    const core = landedCores.get(hex)
    if (!core) return
    core.ready()
      .then(async () => { if (!(await core.has(0, core.length))) await core.download({ start: 0, end: core.length }).done() })
      .catch(() => {})
      .then(() => { if (landedCores.get(hex) === core && !heldElsewhere(hex, null)) dropLanding(hex) })
  }
  async function releaseLanding (channelHex, { purge = false } = {}) {
    const recs = landedByChannel.get(channelHex)
    if (!recs) return
    if (purge) landedByChannel.delete(channelHex)
    for (const rec of recs.values()) {
      rec.held = false
      if (heldElsewhere(rec.hex, channelHex)) continue
      if (!purge) { closeWhenWhole(rec.hex); continue }
      await dropLanding(rec.hex)
      await ctx.storage.store.purge(b4a.from(rec.hex, 'hex'), { force: true }).catch(() => {})
    }
  }
  function mirrorLanding (changes, channelHex) {
    let recs = landedByChannel.get(channelHex)
    if (!recs) { recs = new Map(); landedByChannel.set(channelHex, recs) }
    // an update means the channel is awake: a landing it let close while asleep follows the owner again
    for (const rec of recs.values()) if (!rec.held) { rec.held = true; openLanding(rec.hex) }
    for (const name of ['system', 'view']) {
      const c = changes?.get(name)
      if (!c?.to?.key || c.incremental) continue
      const hex = b4a.toString(c.to.key, 'hex')
      const prev = recs.get(name)
      if (prev?.hex === hex) continue
      openLanding(hex)
      recs.set(name, { hex, held: true })
      if (prev && !heldElsewhere(prev.hex, channelHex)) dropLanding(prev.hex)
    }
  }
  const primaryCache = { entries: [], byId: new Map(), discovered: [] }
  channel = new Autobee(chNs, targetKey ? b4a.from(targetKey, 'hex') : null, {
    ...(founderKeyPair ? { keyPair: founderKeyPair } : {}),
    apply: primaryApply,
    update: (view, changes) => { mirrorLanding(changes, b4a.toString(channel.key, 'hex')); syncWriterCores().catch(() => {}); ctx.update() },
    optimistic: true,
    isTrusted: makeIsTrusted(() => b4a.toString(channel.key, 'hex')),
    wakeup
  })
  ctx.undo.push(() => channel.close())
  await channel.ready()

  const primaryKey = b4a.toString(channel.key, 'hex')
  let usePrimaryChannel = Boolean(targetKey) || initialSources.length === 0
  let channelHasEntries = false
  if (channel.bootstrap.writable && !ctx.identity.foundedKey()) ctx.identity.markFounded(primaryKey)
  ctx.identity.saveIdentity()

  if (!targetKey && channel.local.length === 0 && channel.bootstrap.writable) {
    await channel.append(b4a.from(JSON.stringify({ type: 'init', owner: ctx.identity.idVault?.ownerPublicKey || undefined, epoch: 1 })))
    await channel.updated()
  }

  // Reconciles secondary writer cores straight from the authoritative `writer/*` view prefix so `apply` stays pure.
  function syncWriterCores () {
    const run = async () => {
      if (ctx.life.closing || !channel) return
      const wanted = new Set()
      for await (const n of channel.view.createReadStream({ gte: b4a.from('writer/'), lt: b4a.from('writer/\xff') })) {
        const wHex = b4a.toString(n.key).slice(7)
        if (HEX64.test(wHex) && wHex !== primaryKey) wanted.add(wHex)
      }
      if (ctx.life.closing) return
      for (const [hex, c] of [...writerCores]) {
        if (!wanted.has(hex)) {
          writerCores.delete(hex)
          await c.close().catch(() => {})
        }
      }
      for (const hex of wanted) {
        if (writerCores.has(hex) || ctx.life.closing) continue
        const c = ctx.storage.store.get({ key: b4a.from(hex, 'hex'), active: false })
        writerCores.set(hex, c)
        await c.ready().catch(() => {})
      }
    }
    const next = writerSync.then(run, run)
    writerSync = next.catch(() => {})
    return next
  }

  if (usePrimaryChannel) await (isWorklet ? applied(channel) : channel.update())
  if (channel.writable && ctx.identity.idVault && ctx.identity.foundedKey() === primaryKey && !(await channel.view.get(b4a.from('meta/owner')))) {
    await channel.append(b4a.from(JSON.stringify({ type: 'owner', owner: ctx.identity.idVault.ownerPublicKey })))
    await channel.updated()
  }

  async function refreshPrimaryCache ({ force = false } = {}) {
    if (ctx.life.closing) return
    // The node's own channel is read on every call, exactly as before the pool. Caching this one
    // broke co-writer visibility: Autobee only interrupts for its own updates, so a peer's publish
    // could land with `dirty` still false and nothing would rescan — the owner waited out the whole
    // 120 s window in test/network.test.js and never saw the entry. The pool exists for thousands of
    // *followed* channels; this one is one channel, and correctness wins.
    if (force) {
      for (const session of wakeup.getSessions(channel.key, { discoveryKey: channel.discoveryKey })) {
        try { session.broadcastLookup() } catch {}
      }
      await Promise.race([channel.update().catch(() => {}), new Promise(r => setTimeout(r, 2_000))])
    } else await applied(channel)
    let scan
    try {
      scan = await ctx.sources.scanChannelView(channel.view, primaryKey)
    } catch (err) {
      // A landed view whose blocks nobody serves ends at the read stream's timeout; the last complete scan stands.
      if (err?.code !== 'REQUEST_TIMEOUT') throw err
      return
    }
    const { entriesList, discoveredList } = scan
    // Replace, never merge: the primary is fully applied before every scan, so an announce that is
    // gone is really gone. Merging kept deleted titles alive for findEntry forever.
    ctx.sources.indexChannelRecords(primaryCache, entriesList, discoveredList)
  }

  async function currentChannelEpoch () {
    await applied(channel)
    const n = await channel.view.get(b4a.from('meta/epoch'))
    return n ? (Number(b4a.toString(n.value)) || 1) : 1
  }

  async function publishSource ({ sourceKey, title }) {
    const op = decodeOp(JSON.stringify({ type: 'source', sourceKey: String(sourceKey || '').toLowerCase(), kind: 'channel', title: cleanText(title, String(sourceKey).slice(0, 12)) }))
    if (!op) throw new Error('Invalid source directory record')
    await append(op)
    ctx.update()
    return op
  }

  async function unpublishSource (sourceKey) {
    const k = String(sourceKey || '').trim().toLowerCase()
    if (!HEX64.test(k)) throw new Error('Invalid source key')
    await channel.update()
    const writer = b4a.toString(channel.local.key, 'hex')
    const pfx = 'source/'
    for await (const n of channel.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
      const fullKey = b4a.toString(n.key)
      if (fullKey.endsWith(`/${k}`) && (fullKey === `source/${writer}/${k}` || (await localRole()) === 'owner')) {
        await append({ type: 'remove', key: fullKey })
      }
    }
    ctx.update()
    return { unpublished: true, key: k }
  }

  async function publishedSources () {
    const out = new Map()
    if (!usePrimaryChannel && !channelHasEntries) return []
    await applied(channel)
    const pfx = 'source/'
    for await (const node of channel.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
      const op = decodeOp(node.value)
      if (op?.type === 'source' && !out.has(op.sourceKey)) {
        out.set(op.sourceKey, { key: op.sourceKey, kind: 'channel', title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    return [...out.values()]
  }

  async function remove (key) {
    const cleanKey = key.startsWith(`channel:${primaryKey}/`) ? key.slice(primaryKey.length + 9) : key.startsWith(`tracker:${primaryKey}/`) ? key.slice(primaryKey.length + 9) : key
    const prev = await ctx.catalog.findEntry(cleanKey).catch(() => null)
    await append({ type: 'remove', key: cleanKey })
    await ctx.blobs.gcUnreferencedSlotBlob(prev).catch(() => {})
    ctx.update()
  }

  async function append (op) {
    usePrimaryChannel = true
    if (op.type === 'announce' || op.type === 'source') channelHasEntries = true
    ctx.net.joinOverlayTopic(`channel:${primaryKey}`, channel.key, channel.discoveryKey)
    const writerHex = b4a.toString(channel.local.key, 'hex')
    const ownerRec = !channel.writable && ctx.identity.idVault ? await channel.view.get(b4a.from('meta/owner')) : null
    const canClaim = Boolean(ctx.identity.idVault && (ctx.identity.idVault.channelKey === primaryKey || (ownerRec && b4a.toString(ownerRec.value) === ctx.identity.idVault.ownerPublicKey)))
    const payload = (!channel.writable && canClaim && op.type !== 'claim')
      ? { ...op, claim: ctx.identity.idVault.signClaim(primaryKey, writerHex) }
      : op
    const before = channel.local.length
    await channel.append(b4a.from(JSON.stringify(payload)), { optimistic: !channel.writable })
    await channel.updated()
    while (channel.local.length <= before) {
      if (ctx.life.closing) throw new Error('Node closed before the write was durable')
      await new Promise(resolve => setTimeout(resolve, 500))
      await channel.update()
    }
    await syncWriterCores()
  }

  async function localRole () {
    const writerHex = b4a.toString(channel.local.key, 'hex')
    if (writerHex === primaryKey) return 'owner'
    await applied(channel)
    const rec = await channel.view.get(b4a.from(`writer/${writerHex}`))
    if (rec) {
      try { return JSON.parse(b4a.toString(rec.value))?.role || null } catch {}
    }
    const ownerRec = ctx.identity.idVault ? await channel.view.get(b4a.from('meta/owner')) : null
    return ctx.identity.idVault && (ctx.identity.idVault.channelKey === primaryKey || (ownerRec && b4a.toString(ownerRec.value) === ctx.identity.idVault.ownerPublicKey)) ? 'owner' : null
  }

  async function listWriters () {
    await applied(channel)
    const selfHex = b4a.toString(channel.local.key, 'hex')
    const out = new Map()
    out.set(primaryKey, { key: primaryKey, role: 'owner', alias: 'primary', self: primaryKey === selfHex })
    for await (const n of channel.view.createReadStream({ gte: b4a.from('writer/'), lt: b4a.from('writer/\xff') })) {
      const k = b4a.toString(n.key).slice(7)
      let meta = {}
      try { meta = JSON.parse(b4a.toString(n.value)) || {} } catch {}
      out.set(k, { key: k, role: meta.role || 'writer', alias: cleanText(meta.alias || ''), self: k === selfHex })
    }
    return [...out.values()]
  }

  async function grantWriter (writerKey, { role = 'writer', alias = '' } = {}) {
    const wHex = String(writerKey || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (!ROLES.has(role)) throw new Error('Role must be owner, mod, or writer')
    await append({ type: 'grant', writer: wHex, role, alias: cleanText(alias) })
    return { granted: true, writer: wHex, role, alias: cleanText(alias) }
  }

  async function revokeWriter (writerKey, { purgeEntries = false } = {}) {
    const wHex = String(writerKey || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (wHex === primaryKey) throw new Error('Cannot revoke the genesis channel founder')
    await append({ type: 'revoke', writer: wHex, purgeEntries: Boolean(purgeEntries) })
    ctx.update()
    return { revoked: true, writer: wHex, purgeEntries: Boolean(purgeEntries) }
  }

  return {
    channel,
    primaryKey,
    wakeup,
    writerCores,
    landedCores,
    primaryCache,
    mirrorLanding,
    releaseLanding,
    syncWriterCores,
    refreshPrimaryCache,
    currentChannelEpoch,
    publishSource,
    unpublishSource,
    publishedSources,
    remove,
    append,
    localRole,
    listWriters,
    grantWriter,
    revokeWriter,
    // FindingPeers is per Corestore instance: the primary Autobee's cores live on its namespace, not the root store.
    findingPeers: () => chNs.findingPeers(),
    usePrimary: () => usePrimaryChannel,
    markUsePrimary: () => { usePrimaryChannel = true },
    hasEntries: () => channelHasEntries,
    markHasEntries: () => { channelHasEntries = true },
    viewEpoch: () => viewEpoch,
    bumpView: () => { viewEpoch++ }
  }
}
