/**
 * Hypercore Reader Worker
 *
 * Runs in a separate thread and serves read/seek requests
 * from Hypercore via bare-channel.
 */

import Channel from 'bare-channel'
import Corestore from 'corestore'

const MAX_CACHE_BYTES = 64 * 1024 * 1024
const PREFETCH_BLOCKS = 4

class HypercoreReader {
  constructor(storagePath, blobsCoreKey, blobInfo, dataPort, cmdPort) {
    this.storagePath = storagePath
    this.blobsCoreKey = blobsCoreKey
    this.blobInfo = blobInfo
    this.dataPort = dataPort
    this.cmdPort = cmdPort

    this.core = null
    this.store = null

    this.startBlock = blobInfo.blockOffset
    this.blockLength = blobInfo.blockLength
    this.endBlock = this.startBlock + this.blockLength
    this.byteLength = blobInfo.byteLength

    // NOTE: Blob byteOffset is absolute in the core; data starts at block boundary.
    this.byteOffset = 0

    this.blockSize = null

    this.cache = new Map()
    this.cacheBytes = 0
    this.running = true

    console.log('[HypercoreWorker] Created for core', String(blobsCoreKey).slice(0, 16),
      'blocks:', this.blockLength, 'bytes:', Math.round(this.byteLength / 1024 / 1024) + 'MB')
  }

  async start() {
    this.store = new Corestore(this.storagePath, {
      readOnly: true,
      writable: false,
      allowBackup: true
    })
    await this.store.ready()

    const keyBuf = Buffer.from(this.blobsCoreKey, 'hex')
    this.core = this.store.get(keyBuf)
    await this.core.ready()

    await this.ensureBlockSize()
    this.listenForCommands()
  }

  async ensureBlockSize() {
    if (this.blockSize) return this.blockSize
    const first = await this.getBlock(this.startBlock)
    this.blockSize = first?.length || 65536
    console.log('[HypercoreWorker] Using block size:', this.blockSize)
    return this.blockSize
  }

  async listenForCommands() {
    while (this.running) {
      try {
        const cmd = await this.cmdPort.read()
        if (cmd === null) break
        await this.handleCommand(cmd)
      } catch (err) {
        console.error('[HypercoreWorker] Command read error:', err.message)
        break
      }
    }
  }

  async handleCommand(cmd) {
    switch (cmd.type) {
      case 'read':
        await this.handleReadRequest(cmd.offset, cmd.length)
        break
      case 'seek':
        this.handleSeek(cmd.offset)
        break
      case 'stop':
        this.running = false
        this.cache.clear()
        this.cacheBytes = 0
        break
      default:
        console.warn('[HypercoreWorker] Unknown command:', cmd.type)
    }
  }

  async handleReadRequest(offset, length) {
    if (offset >= this.byteLength) {
      this.sendEof()
      return
    }
    const data = await this.readRange(offset, length)
    if (!data || data.length === 0) {
      this.sendEof()
      return
    }
    this.sendData(offset, data)
  }

  handleSeek(offset) {
    this.prefetchAround(offset).catch(() => {})
  }

  async prefetchAround(offset) {
    await this.ensureBlockSize()
    const pos = this.getBlockPosition(offset)
    if (!pos) return
    const start = pos.blockIndex
    for (let i = 0; i < PREFETCH_BLOCKS; i++) {
      const idx = start + i
      if (idx >= this.endBlock) break
      await this.getBlock(idx)
    }
  }

  getBlockPosition(bytePos) {
    const blockSize = this.blockSize || 65536
    const adjusted = bytePos + this.byteOffset
    const blockIndex = this.startBlock + Math.floor(adjusted / blockSize)
    if (blockIndex < this.startBlock || blockIndex >= this.endBlock) return null
    const offsetInBlock = adjusted % blockSize
    return { blockIndex, offsetInBlock }
  }

  async getBlock(index) {
    if (index < this.startBlock || index >= this.endBlock) return null
    const cached = this.cache.get(index)
    if (cached) {
      cached.lastAccess = Date.now()
      return cached.data
    }

    let data = null
    try {
      data = await this.core.get(index)
    } catch (err) {
      console.error('[HypercoreWorker] core.get failed at', index, err?.message || err)
    }

    if (!data) return null

    const copy = Buffer.alloc(data.length)
    data.copy(copy)
    this.cache.set(index, { data: copy, lastAccess: Date.now() })
    this.cacheBytes += copy.length
    this.evictCache()
    return copy
  }

  evictCache() {
    if (this.cacheBytes <= MAX_CACHE_BYTES) return
    const entries = Array.from(this.cache.entries())
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    for (const [idx, entry] of entries) {
      if (this.cacheBytes <= MAX_CACHE_BYTES) break
      this.cache.delete(idx)
      this.cacheBytes -= entry.data.length
    }
  }

  async readRange(offset, length) {
    await this.ensureBlockSize()

    const toRead = Math.min(length, this.byteLength - offset)
    const out = Buffer.alloc(toRead)
    let written = 0
    let pos = offset

    while (written < toRead) {
      const loc = this.getBlockPosition(pos)
      if (!loc) break
      const block = await this.getBlock(loc.blockIndex)
      if (!block) break

      const available = Math.min(block.length - loc.offsetInBlock, toRead - written)
      if (available <= 0) break
      block.copy(out, written, loc.offsetInBlock, loc.offsetInBlock + available)
      written += available
      pos += available
    }

    if (written === 0) return null
    return written === out.length ? out : out.slice(0, written)
  }

  sendData(offset, data) {
    try {
      this.dataPort.writeSync({
        type: 'data',
        offset,
        length: data.byteLength,
        buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      })
    } catch (err) {
      console.error('[HypercoreWorker] Failed to send data:', err.message)
    }
  }

  sendError(message) {
    try {
      this.dataPort.writeSync({ type: 'error', message })
    } catch (err) {
      console.error('[HypercoreWorker] Failed to send error:', err.message)
    }
  }

  sendEof() {
    try {
      this.dataPort.writeSync({ type: 'eof' })
    } catch (err) {
      console.error('[HypercoreWorker] Failed to send EOF:', err.message)
    }
  }

  destroy() {
    this.running = false
    this.cache.clear()
    this.cacheBytes = 0
    try { this.store?.close?.() } catch {}
    console.log('[HypercoreWorker] Destroyed')
  }
}

const threadData = globalThis?.Bare?.Thread?.self?.data || {}
const dataChannel = Channel.from(threadData.dataChannelHandle)
const cmdChannel = Channel.from(threadData.cmdChannelHandle)
const dataPort = dataChannel.connect()
const cmdPort = cmdChannel.connect()

const reader = new HypercoreReader(
  threadData.storagePath,
  threadData.blobsCoreKey,
  threadData.blobInfo,
  dataPort,
  cmdPort
)

;(async () => {
  try {
    await reader.start()
    dataPort.writeSync({ type: 'ready', fileSize: threadData.blobInfo?.byteLength || 0 })
  } catch (err) {
    const message = err?.message || String(err)
    try { dataPort.writeSync({ type: 'error', message }) } catch {}
    reader.destroy()
  }
})()

console.log('[HypercoreWorker] Started')
