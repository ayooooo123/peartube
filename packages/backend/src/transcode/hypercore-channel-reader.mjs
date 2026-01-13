/**
 * HypercoreChannelReader
 *
 * Provides IOContext-compatible sync read/seek using bare-channel
 * to communicate with a Hypercore reader worker thread.
 *
 * Key features:
 * - readSync() blocks natively (no event loop deadlock)
 * - Reads directly from Hypercore storage (no temp file)
 */

import Thread from 'bare-thread'
import Channel from 'bare-channel'
import Bundle from 'bare-bundle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

function getWorkerOverride() {
  try {
    const override = globalThis?.__PEARTUBE_HYPERCORE_WORKER_PATH__
    if (typeof override === 'string' && override.trim()) {
      return override.trim()
    }
    const appDir = globalThis?.Pear?.config?.dir
    if (typeof appDir === 'string' && appDir.trim()) {
      return path.join(appDir, 'build/workers/hypercore-reader-worker.mjs')
    }
    const applink = globalThis?.Pear?.config?.applink
    if (typeof applink === 'string' && applink.trim()) {
      const base = applink.endsWith('/') ? applink : `${applink}/`
      return new URL('build/workers/hypercore-reader-worker.mjs', base).href
    }
    if (globalThis?.Pear && typeof import.meta?.url === 'string') {
      return new URL('../../../../../build/workers/hypercore-reader-worker.mjs', import.meta.url).href
    }
  } catch {}
  return null
}

function getLocalWorkerPaths() {
  try {
    const cwd = typeof os?.cwd === 'function' ? os.cwd() : null
    if (cwd) {
      return [
        path.join(cwd, 'node_modules/@peartube/backend/src/transcode/hypercore-reader-worker.mjs'),
        path.join(cwd, 'build/workers/hypercore-reader-worker.mjs'),
      ]
    }
  } catch {}
  return []
}

function normalizeWorkerSpec(spec) {
  if (!spec) return null
  if (spec instanceof URL) return spec

  const value = String(spec).trim()
  if (!value) return null

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  if (hasScheme) {
    try {
      return new URL(value)
    } catch {
      return value
    }
  }

  if (value.startsWith('/')) {
    try {
      return new URL(`file://${encodeURI(value)}`)
    } catch {
      return value
    }
  }

  try {
    return new URL(value, import.meta.url)
  } catch {
    return value
  }
}

function formatWorkerSpec(spec) {
  return spec instanceof URL ? spec.href : String(spec)
}

function resolveWorkerFilePath(workerSpec) {
  if (!workerSpec) return null
  const url = workerSpec instanceof URL ? workerSpec : normalizeWorkerSpec(workerSpec)
  if (!url || !(url instanceof URL)) return null

  if (url.protocol === 'file:') {
    return url.pathname
  }

  if (url.protocol === 'pear:') {
    const appDir = globalThis?.Pear?.config?.dir
    if (typeof appDir === 'string' && appDir.trim()) {
      const relPath = url.pathname.replace(/^\/+/, '')
      if (relPath) return path.join(appDir, relPath)
    }
  }

  return null
}

function buildWorkerBundle(workerSpec) {
  const url = workerSpec instanceof URL ? workerSpec : normalizeWorkerSpec(workerSpec)
  if (!url || !(url instanceof URL)) return null

  const filePath = resolveWorkerFilePath(url)
  if (!filePath) return null

  let source = null
  try {
    source = fs.readFileSync(filePath)
  } catch {
    return null
  }

  let entryUrl
  try {
    entryUrl = new URL(`file://${encodeURI(filePath)}`)
  } catch {
    return null
  }

  const bundle = new Bundle()
  bundle.write(entryUrl.href, source, { main: true })
  return bundle.toBuffer({ shared: true })
}

export class HypercoreChannelReader {
  constructor(storagePath, blobsCoreKey, blobInfo) {
    this.storagePath = storagePath
    this.blobsCoreKey = blobsCoreKey
    this.blobInfo = blobInfo
    this.fileSize = blobInfo?.byteLength || 0

    // Channels for communication with worker
    this.dataChannel = null
    this.cmdChannel = null
    this.dataPort = null
    this.cmdPort = null

    // Worker
    this.thread = null
    this.threadReady = false
    this.threadUrl = null

    // Read buffer - stores data received from worker
    this.buffer = new Map() // offset -> { data, end }

    // Current position for IOContext
    this.currentPos = 0

    // Stats
    this.bytesRead = 0
    this.readCalls = 0

    console.log('[HypercoreChannelReader] Created for core', String(blobsCoreKey).slice(0, 16),
      'size:', Math.round(this.fileSize / 1024 / 1024) + 'MB')
  }

  async start() {
    const overridePath = getWorkerOverride()
    if (overridePath) {
      console.log('[HypercoreChannelReader] Worker override path:', overridePath)
    }
    const localPaths = getLocalWorkerPaths()
    const pathsToTry = [
      ...(overridePath ? [overridePath] : []),
      ...localPaths,
      './hypercore-reader-worker.mjs',
    ]

    let lastError = null

    for (const pathToTry of pathsToTry) {
      const workerSpec = normalizeWorkerSpec(pathToTry)
      if (!workerSpec) continue

      try {
        await this.startWorker(workerSpec)
        this.threadUrl = workerSpec
        return
      } catch (err) {
        lastError = err
        const message = err?.message || ''
        if (!message.includes('WORKER_NOT_AVAILABLE') && !message.includes('MODULE_NOT_FOUND')) {
          throw err
        }
      }
    }

    throw lastError || new Error('WORKER_NOT_AVAILABLE: Worker module not found')
  }

  async startWorker(workerSpec) {
    return new Promise((resolve, reject) => {
      const dataChannel = new Channel()
      const cmdChannel = new Channel()
      const dataPort = dataChannel.connect()
      const cmdPort = cmdChannel.connect()

      const cleanupAttempt = (threadInstance) => {
        try { threadInstance?.terminate?.() } catch {}
        try { dataPort.close() } catch {}
        try { cmdPort.close() } catch {}
      }

      let threadInstance
      try {
        console.log('[HypercoreChannelReader] Trying worker path:', formatWorkerSpec(workerSpec))
        const threadData = {
          storagePath: this.storagePath,
          blobsCoreKey: this.blobsCoreKey,
          blobInfo: this.blobInfo,
          dataChannelHandle: dataChannel.handle,
          cmdChannelHandle: cmdChannel.handle
        }
        const bundleSource = buildWorkerBundle(workerSpec)
        if (!bundleSource) {
          throw new Error('WORKER_NOT_AVAILABLE: Unable to build worker bundle')
        }
        console.log('[HypercoreChannelReader] Using bundled worker source')
        threadInstance = new Thread(bundleSource, { data: threadData })
      } catch (err) {
        console.warn('[HypercoreChannelReader] Worker init failed:', err?.message || err)
        if (err?.stack) {
          console.warn(err.stack)
        }
        cleanupAttempt(threadInstance)
        reject(new Error('WORKER_NOT_AVAILABLE: Worker module not found'))
        return
      }

      let ready = false
      const timeout = setTimeout(() => {
        if (!ready) {
          cleanupAttempt(threadInstance)
          reject(new Error('WORKER_NOT_AVAILABLE: Worker initialization timeout'))
        }
      }, 30000)

      const waitForReady = async () => {
        try {
          while (true) {
            const msg = await dataPort.read()
            if (msg === null) {
              throw new Error('Channel closed unexpectedly')
            }
            if (msg.type === 'ready') {
              clearTimeout(timeout)
              ready = true
              this.thread = threadInstance
              this.threadReady = true
              this.dataChannel = dataChannel
              this.cmdChannel = cmdChannel
              this.dataPort = dataPort
              this.cmdPort = cmdPort
              console.log('[HypercoreChannelReader] Worker ready')
              resolve()
              return
            }
            if (msg.type === 'error') {
              throw new Error(msg.message || 'Worker error')
            }
          }
        } catch (err) {
          clearTimeout(timeout)
          cleanupAttempt(threadInstance)
          reject(err)
        }
      }

      waitForReady()
    })
  }

  requestData(offset, length) {
    this.cmdPort.writeSync({
      type: 'read',
      offset,
      length
    })

    while (true) {
      const msg = this.dataPort.readSync()
      if (msg === null) {
        throw new Error('Channel closed unexpectedly')
      }

      if (msg.type === 'data') {
        const data = Buffer.from(msg.buffer)
        this.buffer.set(msg.offset, {
          data,
          end: msg.offset + data.byteLength
        })

        if (msg.offset <= offset && msg.offset + data.byteLength >= offset + length) {
          return
        }
      } else if (msg.type === 'error') {
        throw new Error(msg.message)
      } else if (msg.type === 'eof') {
        return
      }
    }
  }

  readFromBuffer(offset, length) {
    for (const [bufOffset, buf] of this.buffer) {
      if (bufOffset <= offset && buf.end >= offset + length) {
        const localOffset = offset - bufOffset
        return buf.data.subarray(localOffset, localOffset + length)
      }
    }
    return null
  }

  syncRead(buffer) {
    this.readCalls++

    if (this.currentPos >= this.fileSize) {
      return 0
    }

    const toRead = Math.min(buffer.length, this.fileSize - this.currentPos)

    let data = this.readFromBuffer(this.currentPos, toRead)
    if (!data) {
      try {
        this.requestData(this.currentPos, toRead)
        data = this.readFromBuffer(this.currentPos, toRead)
      } catch (err) {
        console.error('[HypercoreChannelReader] Read error:', err.message)
        return -1
      }
    }

    if (!data) {
      return 0
    }

    const bytesToCopy = Math.min(data.byteLength, buffer.length)
    data.copy(buffer, 0, 0, bytesToCopy)
    this.currentPos += bytesToCopy
    this.bytesRead += bytesToCopy

    this.cleanupBuffer()
    return bytesToCopy
  }

  syncSeek(offset, whence) {
    const SEEK_SET = 0
    const SEEK_CUR = 1
    const SEEK_END = 2
    const AVSEEK_SIZE = 0x10000

    if (whence === AVSEEK_SIZE) {
      return this.fileSize
    }

    let newPos = this.currentPos
    if (whence === SEEK_SET) {
      newPos = offset
    } else if (whence === SEEK_CUR) {
      newPos += offset
    } else if (whence === SEEK_END) {
      newPos = this.fileSize + offset
    }

    newPos = Math.max(0, Math.min(newPos, this.fileSize))

    if (Math.abs(newPos - this.currentPos) > 1024 * 1024) {
      console.log('[HypercoreChannelReader] Seek:', Math.round(this.currentPos / 1024 / 1024) + 'MB →', Math.round(newPos / 1024 / 1024) + 'MB')
      try {
        this.cmdPort.writeSync({
          type: 'seek',
          offset: newPos
        })
      } catch {}
    }

    this.currentPos = newPos
    return this.currentPos
  }

  cleanupBuffer() {
    const keepWindow = 10 * 1024 * 1024
    const toDelete = []

    for (const [offset, buf] of this.buffer) {
      if (buf.end < this.currentPos - keepWindow || offset > this.currentPos + keepWindow) {
        toDelete.push(offset)
      }
    }

    for (const offset of toDelete) {
      this.buffer.delete(offset)
    }
  }

  createIOContext(ffmpeg) {
    const self = this
    const ioContext = new ffmpeg.IOContext(65536, {
      onread: (buffer) => self.syncRead(buffer),
      onseek: (offset, whence) => self.syncSeek(offset, whence),
    })

    ioContext._reader = this
    ioContext._cleanup = () => {
      console.log('[HypercoreChannelReader] Cleanup - bytes read:', Math.round(self.bytesRead / 1024 / 1024) + 'MB, read calls:', self.readCalls)
    }

    return ioContext
  }

  destroy() {
    console.log('[HypercoreChannelReader] Destroying')

    if (this.cmdPort) {
      try { this.cmdPort.writeSync({ type: 'stop' }) } catch {}
    }

    if (this.thread) {
      setTimeout(() => {
        try { this.thread.terminate?.() } catch {}
      }, 1000)
    }

    if (this.dataPort) {
      try { this.dataPort.close() } catch {}
    }
    if (this.cmdPort) {
      try { this.cmdPort.close() } catch {}
    }

    this.buffer.clear()
  }
}

export default HypercoreChannelReader
