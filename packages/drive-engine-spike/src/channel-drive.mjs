import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'

import {
  createProfileRecord,
  createVideoRecord,
  videoRecordPath,
  videoSourcePath
} from './schema.mjs'

export const SAMPLE_VIDEO_HEADER = 'PEARTUBE_DRIVE_ENGINE_SPIKE'

export async function createChannelDrive({ storagePath, name }) {
  const store = new Corestore(storagePath)
  const drive = new Hyperdrive(store)
  await drive.ready()

  const channelKey = b4a.toString(drive.key, 'hex')
  const profile = createProfileRecord({ channelKey, name })
  await putJson(drive, '/profile.json', profile)

  return {
    store,
    drive,
    channelKey,
    async close() {
      await drive.close()
      await store.close()
    }
  }
}

export async function writeSampleVideo({ drive, channelKey, id, title, size = 1024 * 1024 }) {
  const filename = videoSourcePath(id)
  const bytes = createSampleVideoBuffer(size)
  await drive.put(filename, bytes)

  const record = createVideoRecord({
    channelKey,
    id,
    title,
    filename,
    byteLength: bytes.byteLength,
    mimeType: 'video/mp4'
  })
  await putJson(drive, videoRecordPath(id), record)

  return record
}

export async function readJson(drive, filename) {
  const buf = await drive.get(filename)
  if (!buf) return null
  return JSON.parse(buf.toString('utf8'))
}

async function putJson(drive, filename, value) {
  await drive.put(filename, Buffer.from(JSON.stringify(value, null, 2)))
}

function createSampleVideoBuffer(size) {
  if (!Number.isSafeInteger(size) || size < SAMPLE_VIDEO_HEADER.length) {
    throw new Error('sample video size must fit header')
  }
  const buf = Buffer.alloc(size, 0)
  buf.write(SAMPLE_VIDEO_HEADER, 0, 'utf8')
  for (let i = SAMPLE_VIDEO_HEADER.length; i < buf.length; i++) {
    buf[i] = i % 251
  }
  return buf
}
