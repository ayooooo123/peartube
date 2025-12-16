import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'
import b4a from 'b4a'

import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await sleep(intervalMs)
  }
}

async function writeBlobFile(drive, filePath, buf) {
  await new Promise((resolve, reject) => {
    const ws = drive.createWriteStream(filePath)
    ws.on('error', reject)
    ws.on('close', resolve)
    ws.end(buf)
  })
}

async function main() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-mw-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-mw-b-'))

  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)

  await storeA.ready()
  await storeB.ready()

  // Create channel on A
  const chA = new MultiWriterChannel(storeA, { encrypt: false })
  await chA.ready()
  await chA.updateMetadata({ name: 'Test Channel', description: 'multiwriter', avatar: null })

  // Open same channel on B (read-only until added as writer)
  const chB = new MultiWriterChannel(storeB, { key: chA.key, encrypt: false })
  await chB.ready()

  // Wire up replication between stores
  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  // Add B as writer (A appends membership op)
  await chA.addWriter({ keyHex: chB.localWriterKeyHex, role: 'device', deviceName: 'Device B' })

  // Wait until B becomes writable
  await chB.base.waitForWritable()

  // Create blob drive + upload a tiny video on A
  const blobDriveKeyA = await chA.ensureLocalBlobDrive({ deviceName: 'Device A' })
  const blobDriveA = await chA.getBlobDrive(blobDriveKeyA)

  await writeBlobFile(blobDriveA, '/videos/vid1.mp4', b4a.from('hello world'))

  await chA.addVideo({
    id: 'vid1',
    title: 'Video One',
    description: '',
    path: '/videos/vid1.mp4',
    mimeType: 'video/mp4',
    size: 11,
    uploadedAt: Date.now(),
    blobDriveKey: blobDriveKeyA
  })

  // Wait for B to see video metadata
  const vB = await waitFor(() => chB.getVideo('vid1'), { timeoutMs: 20000 })
  if (!vB || vB.id !== 'vid1') throw new Error('Video did not replicate to B')

  // Conflict case: A and B update same video title concurrently
  await Promise.all([
    chA.base.append({ type: 'update-video', id: 'vid1', title: 'Title from A' }),
    chB.base.append({ type: 'update-video', id: 'vid1', title: 'Title from B' })
  ])

  // Wait for convergence
  await waitFor(async () => {
    await chA.base.update()
    await chB.base.update()
    const a = await chA.getVideo('vid1')
    const b = await chB.getVideo('vid1')
    if (!a || !b) return null
    return a.title === b.title ? { a, b } : null
  }, { timeoutMs: 20000, intervalMs: 200 })

  // Cleanup
  await chA.close()
  await chB.close()
  s1.destroy()
  s2.destroy()
  await storeA.close()
  await storeB.close()

  console.log('[OK] Multi-writer channel harness passed')
}

main().catch((err) => {
  console.error('[FAIL] Multi-writer channel harness failed:', err)
  process.exitCode = 1
})


