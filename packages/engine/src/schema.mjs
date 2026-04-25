const PROFILE_TYPE = 'peartube.profile'
const VIDEO_TYPE = 'peartube.video'
const SCHEMA_VERSION = 1

export function createProfileRecord({ channelKey, name, createdAt = Date.now() }) {
  return {
    type: PROFILE_TYPE,
    schemaVersion: SCHEMA_VERSION,
    channelKey,
    name,
    createdAt
  }
}

export function createVideoRecord({
  channelKey,
  id,
  title,
  filename = videoSourcePath(id),
  byteLength,
  mimeType = 'video/mp4',
  createdAt = Date.now()
}) {
  return {
    type: VIDEO_TYPE,
    schemaVersion: SCHEMA_VERSION,
    channelKey,
    id,
    title,
    filename,
    byteLength,
    mimeType,
    createdAt
  }
}

export function validateProfileRecord(record) {
  if (!isObject(record)) return fail('profile record must be an object')
  if (record.type !== PROFILE_TYPE) return fail('profile type is invalid')
  if (record.schemaVersion !== SCHEMA_VERSION) return fail('profile schemaVersion is invalid')
  if (!isNonEmptyString(record.channelKey)) return fail('profile channelKey is required')
  if (!isNonEmptyString(record.name)) return fail('profile name is required')
  if (!isFiniteNumber(record.createdAt)) return fail('profile createdAt is required')
  return ok()
}

export function validateVideoRecord(record) {
  if (!isObject(record)) return fail('video record must be an object')
  if (record.type !== VIDEO_TYPE) return fail('video type is invalid')
  if (record.schemaVersion !== SCHEMA_VERSION) return fail('video schemaVersion is invalid')
  if (!isNonEmptyString(record.channelKey)) return fail('video channelKey is required')
  if (!isSafeSegment(record.id)) return fail('video id is invalid')
  if (!isNonEmptyString(record.title)) return fail('video title is required')
  if (!isSafeVideoFilename(record.filename, record.id)) return fail('video filename is invalid')
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) return fail('video byteLength is invalid')
  if (!isNonEmptyString(record.mimeType)) return fail('video mimeType is required')
  if (!isFiniteNumber(record.createdAt)) return fail('video createdAt is required')
  return ok()
}

export function videoRecordPath(id) {
  if (!isSafeSegment(id)) throw new Error('invalid video id')
  return `/videos/${id}/video.json`
}

export function videoSourcePath(id) {
  if (!isSafeSegment(id)) throw new Error('invalid video id')
  return `/videos/${id}/source.mp4`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
}

function isSafeVideoFilename(filename, id) {
  if (typeof filename !== 'string') return false
  if (!filename.startsWith('/')) return false
  if (filename.includes('..')) return false
  if (filename.includes('\\')) return false
  return filename === videoSourcePath(id)
}

function ok() {
  return { ok: true }
}

function fail(error) {
  return { ok: false, error }
}
