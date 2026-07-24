import test from 'brittle'

import { createMediaValidationPolicy, validateHostileMediaProbe } from '../src/assets/media-validation.js'

test('hostile media validation rejects oversized media before decode/allocation', (t) => {
  const policy = createMediaValidationPolicy({ maxWidth: 3840, maxHeight: 2160, maxDurationMs: 7200000, maxTracks: 8, maxContainerTables: 4096, maxSubtitleCues: 50000, maxArtworkBytes: 5 * 1024 * 1024 })

  t.exception(() => validateHostileMediaProbe({ width: 8000, height: 4320, durationMs: 1000, tracks: 1 }, policy), /width/)
  t.exception(() => validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 9000000, tracks: 1 }, policy), /duration/)
  t.exception(() => validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 1000, tracks: 32 }, policy), /track/)
  t.exception(() => validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 1000, tracks: 1, containerTables: 5000 }, policy), /table/)
  t.exception(() => validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 1000, tracks: 1, subtitleCues: 100000 }, policy), /subtitle/)
  t.exception(() => validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 1000, tracks: 1, artworkBytes: 9 * 1024 * 1024 }, policy), /artwork/)
})

test('hostile media validation rejects malformed offsets, overflow, archives, timeout, cancellation, and worker crash', (t) => {
  const policy = createMediaValidationPolicy()

  t.exception(() => validateHostileMediaProbe({ width: 100, height: 100, durationMs: 1, tracks: 1, offsets: [{ start: 10, end: 9 }] }, policy), /offset/)
  t.exception(() => validateHostileMediaProbe({ width: 100, height: 100, durationMs: 1, tracks: 1, byteLength: Number.MAX_SAFE_INTEGER + 1 }, policy), /byteLength/)
  t.exception(() => validateHostileMediaProbe({ archive: true, archivePaths: ['a/'.repeat(1000)] }, policy), /archive/)
  t.exception(() => validateHostileMediaProbe({ timedOut: true }, policy), /timeout/)
  t.exception(() => validateHostileMediaProbe({ cancelled: true }, policy), /cancelled/)
  t.exception(() => validateHostileMediaProbe({ workerCrashed: true }, policy), /worker/)
})

test('hostile media validation reports reservation release on every terminal outcome', (t) => {
  const reservations = []
  const policy = createMediaValidationPolicy({ onReserve: name => reservations.push(`reserve:${name}`), onRelease: name => reservations.push(`release:${name}`) })

  t.alike(validateHostileMediaProbe({ width: 1920, height: 1080, durationMs: 1000, tracks: 2, byteLength: 1024 }, policy).accepted, true)
  t.exception(() => validateHostileMediaProbe({ timedOut: true }, policy), /timeout/)
  t.alike(reservations, ['reserve:probe', 'release:probe', 'reserve:probe', 'release:probe'])
})
