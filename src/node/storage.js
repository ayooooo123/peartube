import Corestore from 'corestore'
import CoreStorage from 'hypercore-storage'
import b4a from 'b4a'
import os from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

export async function createStorage (ctx) {
  const { storage, worklet: isWorklet } = ctx.opts
  const csDir = join(storage, 'corestore')
  // The node owns its hypercore-storage so compaction and core lookups go through that instance, not Corestore internals.
  // App worklets keep RocksDB caches and open SST readers small: a 50 GB library rides the OS page cache instead of app RAM.
  const isMobileWorklet = isWorklet && os.platform() !== 'darwin'
  const storageOpts = isWorklet
    ? {
        writeBufferSize: isMobileWorklet ? 12 * 1024 * 1024 : 32 * 1024 * 1024,
        maxOpenFiles: 48,
        maxBackgroundJobs: isMobileWorklet ? 3 : 4,
        maxFileOpeningThreads: 2,
        blockCache: false,
        tableCacheIndexAndFilterBlocks: false,
        topLevelIndexPinningTier: 0,
        partitionPinningTier: 0,
        unpartitionedPinningTier: 0,
        optimizeFiltersForMemory: true,
        treeCache: { maxSize: 512 }
      }
    : undefined
  let coreStorage = new CoreStorage(csDir, storageOpts)
  let store = new Corestore(coreStorage)
  try {
    await store.ready()
  } catch (err) {
    if (!/Invalid device file/i.test(err?.message || '')) throw err
    await store.close().catch(() => {})
    try { unlinkSync(join(csDir, 'CORESTORE')) } catch {}
    coreStorage = new CoreStorage(csDir, storageOpts)
    store = new Corestore(coreStorage)
    await store.ready()
  }
  ctx.undo.push(() => store.close())
  return {
    coreStorage,
    store,
    isMobileWorklet
  }
}
