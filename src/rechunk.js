// Legacy shared-slot (`blobs-0..N`) splitter: pulled out of src/index.js so the core stays lean while old relay holes still rechunk cleanly.
import { Readable } from 'streamx'
import b4a from 'b4a'

export async function runRechunk (ctx, { id = null, foreground = false, onMigrate = null, onProgress = null, limit = Infinity } = {}) {
  const {
    tracker, usePrimaryTracker, localChannel, withChannelLock, blobSlots, ownedBlobs, store,
    put, append, publishChannel, leaveContentSwarm, ensureBlockCounter, syncBlockCounter,
    status, getTraffic, isClosing, decodeOp, isUniform512, blockSize, update
  } = ctx
  const writer = b4a.toString(tracker.local.key, 'hex')
  const uniformByHash = new Map()
  const legacyGroups = new Map()
  const slotMap = new Map(blobSlots.map(s => [s.key, s]))
  const hasAllBlocks = async (slot, blob) => {
    if (!slot || blob.blockLength <= 0) return blob.byteLength === 0
    const end = blob.blockOffset + blob.blockLength
    return slot.core.length >= end && slot.core.has(blob.blockOffset, end)
  }
  const addRef = async (op, kind, fullKey) => {
    if (!slotMap.has(op.blobs)) {
      if (ownedBlobs.has(op.blobs) && op.blob?.blockOffset === 0 && isUniform512(op.blob)) {
        uniformByHash.set(`${op.sha256}:${op.size}`, { blobs: op.blobs, blob: op.blob })
      }
      return
    }
    const slot = slotMap.get(op.blobs)
    if (!(await hasAllBlocks(slot, op.blob))) return
    const oldTag = `${op.blobs}:${op.blob.blockOffset}`
    let g = legacyGroups.get(oldTag)
    if (!g) {
      g = { oldTag, blobs: op.blobs, blob: op.blob, sha256: op.sha256, size: op.size, trackerOps: [], channelOps: [] }
      legacyGroups.set(oldTag, g)
    }
    if (kind === 'tracker') g.trackerOps.push({ fullKey, op })
    else g.channelOps.push({ fullKey, op })
  }

  if (usePrimaryTracker) {
    await tracker.update()
    for await (const n of tracker.view.createReadStream()) {
      const key = b4a.toString(n.key)
      if (key.startsWith('peer/') || key.startsWith('source/')) continue
      const op = decodeOp(n.value)
      if (op?.type === 'announce' && key.split('/')[1] === writer) await addRef(op, 'tracker', key)
    }
  }
  if (localChannel.core.length > 0) {
    for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
      const subKey = b4a.toString(n.key)
      const op = decodeOp(n.value)
      if (op?.type === 'announce') await addRef(op, 'channel', subKey)
    }
  }

  const allGroups = [...legacyGroups.values()]
  const filtered = id ? allGroups.filter(g => g.trackerOps.some(t => t.op.id === id) || g.channelOps.some(c => c.op.id === id)) : allGroups
  const queue = filtered.sort((a, b) => a.size - b.size)
  let migrated = 0, deduped = 0, migratedBytes = 0
  onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length, migratedBytes, currentId: null, currentTitle: null })

  for (const g of queue) {
    if (isClosing() || migrated >= limit) break
    const sample = g.trackerOps[0]?.op || g.channelOps[0]?.op
    onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: sample.id, currentTitle: sample.title })
    const oldSlot = slotMap.get(g.blobs)
    if (!oldSlot || !(await hasAllBlocks(oldSlot, g.blob))) continue

    let target = uniformByHash.get(`${g.sha256}:${g.size}`)
    if (target && !ownedBlobs.has(target.blobs)) target = null
    if (target) {
      deduped++
    } else {
      let idx = g.blob.blockOffset
      const endIdx = g.blob.blockOffset + g.blob.blockLength
      const src = new Readable({
        read (cb) {
          if (isClosing()) return cb(new Error('Node closing'))
          if (idx >= endIdx) { this.push(null); return cb(null) }
          const pump = () => {
            if (isClosing()) return cb(new Error('Node closing'))
            status()
            const { downBps, upBps } = getTraffic()
            if (!foreground && (downBps > 65536 || upBps > 65536)) { setTimeout(pump, 1500).unref?.(); return }
            const batchEnd = Math.min(endIdx, idx + 64)
            const reqs = []
            while (idx < batchEnd) reqs.push(oldSlot.core.get(idx++, { wait: false }))
            Promise.all(reqs).then(blocks => {
              if (blocks.some(b => !b)) return cb(new Error('Missing local block during rechunk'))
              for (const blk of blocks) this.push(blk)
              setTimeout(() => cb(null), 0)
            }, cb)
          }
          pump()
        }
      })
      let lastProgressBytes = 0
      const newOp = await put({ id: sample.id, title: sample.title }, src, bytes => {
        if (bytes - lastProgressBytes >= blockSize) {
          lastProgressBytes = bytes
          onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes: migratedBytes + bytes, currentId: sample.id, currentTitle: sample.title })
        }
      })
      if (newOp.sha256 !== g.sha256 || newOp.size !== g.size) {
        ownedBlobs.delete(newOp.blobs)
        leaveContentSwarm(newOp.blobs)
        const bad = store.get({ key: b4a.from(newOp.blobs, 'hex') })
        await bad.ready().then(() => bad.purge()).catch(() => bad.close().catch(() => {}))
        throw new Error(`SHA-256 mismatch rechunking ${sample.id}: expected ${g.sha256}, got ${newOp.sha256}`)
      }
      target = { blobs: newOp.blobs, blob: newOp.blob }
      uniformByHash.set(`${g.sha256}:${g.size}`, target)
    }

    await onMigrate?.(g.oldTag, target, sample)
    for (const { op } of g.trackerOps) await append({ ...op, blobs: target.blobs, blob: target.blob })
    for (const { op } of g.channelOps) await publishChannel({ ...op, blobs: target.blobs, blob: target.blob })
    if (g.channelOps.length > 0) {
      await withChannelLock(async () => {
        const w = localChannel.write()
        for (const { fullKey } of g.channelOps) w.tryDelete(b4a.from(fullKey))
        await w.flush()
      })
    }
    for (const { fullKey } of g.trackerOps) await append({ type: 'remove', key: fullKey })

    const clearEnd = Math.min(oldSlot.core.length, g.blob.blockOffset + g.blob.blockLength)
    if (clearEnd > g.blob.blockOffset) {
      await oldSlot.core.clear(g.blob.blockOffset, clearEnd)
      ensureBlockCounter(oldSlot.core)
      syncBlockCounter(oldSlot.core).catch(() => {})
    }
    migrated++
    migratedBytes += g.size
    onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: null, currentTitle: null })
  }

  if (migrated > 0) update()
  return { total: queue.length, migrated, deduped, remaining: Math.max(0, queue.length - migrated), migratedBytes }
}
