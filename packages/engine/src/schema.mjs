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
  description = '',
  filename = videoSourcePath(id),
  byteLength,
  mimeType = 'video/mp4',
  category = '',
  duration = 0,
  width = 0,
  height = 0,
  thumbnail = null,
  thumbnailMimeType = null,
  thumbnailByteLength = 0,
  createdAt = Date.now()
}) {
  return {
    type: VIDEO_TYPE,
    schemaVersion: SCHEMA_VERSION,
    channelKey,
    id,
    title,
    description,
    filename,
    byteLength,
    size: byteLength,
    mimeType,
    category,
    duration,
    width,
    height,
    thumbnail,
    thumbnailMimeType,
    thumbnailByteLength,
    createdAt,
    uploadedAt: createdAt
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
  if (typeof record.description !== 'string') return fail('video description is invalid')
  if (!isSafeVideoFilename(record.filename, record.id)) return fail('video filename is invalid')
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) return fail('video byteLength is invalid')
  if (!Number.isSafeInteger(record.size) || record.size !== record.byteLength) return fail('video size is invalid')
  if (!isNonEmptyString(record.mimeType)) return fail('video mimeType is required')
  if (typeof record.category !== 'string') return fail('video category is invalid')
  if (!isNonNegativeFiniteNumber(record.duration)) return fail('video duration is invalid')
  if (!isNonNegativeFiniteNumber(record.width)) return fail('video width is invalid')
  if (!isNonNegativeFiniteNumber(record.height)) return fail('video height is invalid')
  if (record.thumbnail !== null && typeof record.thumbnail !== 'string') return fail('video thumbnail is invalid')
  if (record.thumbnailMimeType !== null && typeof record.thumbnailMimeType !== 'string') return fail('video thumbnailMimeType is invalid')
  if (!Number.isSafeInteger(record.thumbnailByteLength) || record.thumbnailByteLength < 0) return fail('video thumbnailByteLength is invalid')
  if (!isFiniteNumber(record.createdAt)) return fail('video createdAt is required')
  if (record.uploadedAt !== record.createdAt) return fail('video uploadedAt is invalid')
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

export function videoThumbnailPath(id) {
  if (!isSafeSegment(id)) throw new Error('invalid video id')
  return `/videos/${id}/thumbnail`
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

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0
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
