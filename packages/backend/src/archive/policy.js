import { normalizeAssetCoreRefV2 } from '../assets/rendition.js'

const POLICY_STATE_VERSION = 1
const MAX_RESERVATIONS = 4096

function safeBytes(value, name, { positive = false } = {}) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < (positive ? 1 : 0)) {
    throw new Error(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`)
  }
  return next
}

function safeTimestamp(value, name) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`${name} must be a positive safe integer`)
  return next
}

function reservationId(value) {
  const id = String(value || '')
  if (!id || id.length > 128) throw new Error('pledgeId must be a bounded string')
  return id
}

function pledgeEnvelope(value) {
  if (value == null) return null
  if (typeof value !== 'object' || value === null) throw new Error('pledgeEnvelope must be an object')
  return { ...value }
}

function pledgedRangesFromReservation(reservation) {
  const envelope = reservation?.pledgeEnvelope
  if (envelope && envelope.body != null) {
    let body = envelope.body
    if (typeof body === 'object' && body !== null && !Array.isArray(body) && Array.isArray(body.ranges)) {
      return body.ranges
    }
    try {
      const text = typeof body === 'string'
        ? body
        : (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(body)) || body?.byteLength != null
          ? new TextDecoder().decode(body)
          : null
      if (text) {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed?.ranges)) return parsed.ranges
      }
    } catch {
      // fall through to coreRef
    }
  }
  if (reservation?.coreRef) return [{ start: 0, end: reservation.coreRef.length }]
  return []
}

function cloneReservations(source) {
  return new Map(Array.from(source, ([id, reservation]) => [id, { ...reservation }]))
}

function mergeRangeList(ranges = []) {
  const byCore = new Map()
  for (const r of ranges) {
    if (!Number.isSafeInteger(r?.start) || !Number.isSafeInteger(r?.end) || r.end <= r.start) continue
    const key = r.coreKey ? String(r.coreKey).toLowerCase() : ''
    if (!byCore.has(key)) byCore.set(key, [])
    byCore.get(key).push(r)
  }
  const mergedAll = []
  for (const [key, list] of byCore) {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = [{ ...(key ? { coreKey: key } : {}), start: list[0].start, end: list[0].end }]
    for (let i = 1; i < list.length; i++) {
      const prev = merged[merged.length - 1]
      const cur = list[i]
      if (cur.start <= prev.end) {
        if (cur.end > prev.end) prev.end = cur.end
      } else {
        merged.push({ ...(key ? { coreKey: key } : {}), start: cur.start, end: cur.end })
      }
    }
    mergedAll.push(...merged)
  }
  return mergedAll
}
const MAX_VERIFIED_RANGES = 64

function normalizeVerifiedRange(range = {}, maxEnd = Number.MAX_SAFE_INTEGER) {
  const start = Number(range?.start)
  const end = Number(range?.end)
  const coreKey = range?.coreKey ? String(range.coreKey).toLowerCase() : null
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > maxEnd) {
    throw new Error('invalid verified range bounds')
  }
  return { ...(coreKey ? { coreKey } : {}), start, end }
}

function normalizeVerifiedRanges(ranges = [], maxEnd = Number.MAX_SAFE_INTEGER) {
  if (ranges == null) return []
  if (!Array.isArray(ranges) || ranges.length > MAX_VERIFIED_RANGES) {
    throw new Error(`verifiedRanges must be an array of at most ${MAX_VERIFIED_RANGES} ranges`)
  }
  const validated = []
  for (const r of ranges) {
    validated.push(normalizeVerifiedRange(r, maxEnd))
  }
  return mergeRangeList(validated)
}

function rangesCoverPledged(verifiedRanges = [], pledgedRanges = []) {
  if (!Array.isArray(pledgedRanges) || pledgedRanges.length === 0) return false
  return pledgedRanges.every(p => {
    const start = Number(p?.start)
    const end = Number(p?.end)
    const coreKey = p?.coreKey ? String(p.coreKey).toLowerCase() : null
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return false
    return verifiedRanges.some(v => {
      const vCoreKey = v?.coreKey ? String(v.coreKey).toLowerCase() : null
      if (coreKey !== vCoreKey) return false
      return v.start <= start && v.end >= end
    })
  })
}


function heldBytes(reservations) {
  let total = 0
  for (const reservation of reservations.values()) total += reservation.reservedBytes
  return total
}

function parseReservationCoreRef(rawCoreRef) {
  if (rawCoreRef && typeof rawCoreRef === 'object') {
    try {
      return normalizeAssetCoreRefV2(rawCoreRef)
    } catch {
      return null
    }
  }
  return null
}

function decodeReservation(raw) {
  const pledgeId = reservationId(raw.pledgeId)
  const reservedBytes = safeBytes(raw.reservedBytes, 'reservedBytes')
  const verifiedBytes = raw.verifiedBytes != null ? safeBytes(raw.verifiedBytes, 'verifiedBytes') : 0
  const persistedPledge = pledgeEnvelope(raw.pledgeEnvelope)
  const coreRef = parseReservationCoreRef(raw.coreRef)
  const maxEnd = coreRef ? coreRef.length : Number.MAX_SAFE_INTEGER
  let verifiedRanges = []
  try {
    verifiedRanges = normalizeVerifiedRanges(raw.verifiedRanges, maxEnd)
  } catch {
    throw new Error('archive reservation state is invalid')
  }
  const pledgedRanges = pledgedRangesFromReservation({ coreRef, pledgeEnvelope: persistedPledge })
  const coverageComplete = pledgedRanges.length > 0 ? rangesCoverPledged(verifiedRanges, pledgedRanges) : true
  const complete = raw.verifiedBytes != null && raw.complete === true && verifiedBytes === reservedBytes && verifiedBytes > 0 && coverageComplete
  const expiresAt = safeTimestamp(raw.expiresAt, 'expiresAt')
  if (verifiedBytes > reservedBytes) throw new Error('archive reservation state is inconsistent')
  return {
    pledgeId,
    reservedBytes,
    verifiedBytes,
    complete,
    verifiedRanges,
    expiresAt,
    ...(coreRef ? { coreRef } : {}),
    ...(persistedPledge ? { pledgeEnvelope: persistedPledge } : {}),
  }
}

function decodeState(value, configuredCapacityBytes, hasConfiguredCapacity) {
  const reservations = new Map()
  if (value == null) return { reservations, capacityBytes: configuredCapacityBytes }
  if (value.version !== POLICY_STATE_VERSION || !Array.isArray(value.reservations) || value.reservations.length > MAX_RESERVATIONS) {
    throw new Error('archive reservation state is invalid')
  }
  for (const raw of value.reservations) {
    const reservation = decodeReservation(raw)
    if (reservations.has(reservation.pledgeId)) throw new Error('archive reservation state is inconsistent')
    reservations.set(reservation.pledgeId, reservation)
  }
  const capacityBytes = hasConfiguredCapacity
    ? configuredCapacityBytes
    : safeBytes(value.capacityBytes ?? configuredCapacityBytes, 'capacityBytes')
  if (heldBytes(reservations) > capacityBytes) throw new Error('archive reservation state exceeds configured capacity')
  return { reservations, capacityBytes }
}

function encodeState(reservations, capacityBytes) {
  return {
    version: POLICY_STATE_VERSION,
    capacityBytes,
    reservations: Array.from(reservations.values(), reservation => ({ ...reservation }))
      .sort((left, right) => left.pledgeId.localeCompare(right.pledgeId)),
  }
}

export function createArchivePolicy(options = {}) {
  let capacityBytes = safeBytes(options.capacityBytes ?? 0, 'capacityBytes')
  const diagnostics = options.diagnostics || null
  const repository = options.repository || null
  const now = typeof options.now === 'function' ? options.now : Date.now
  let reservations = new Map()
  // An archive pledge is durable custody the viewer opted into, so the
  // participation decision governs whether a NEW one may be taken - never
  // whether an existing one is kept. A mode alone can never open this gate:
  // archiveEligible is false unless archiveOptIn is true, and archiveOptIn
  // comes from the retention mode the viewer chose. It carries no playback and
  // no upload-quota term, so a dedicated archivist that never plays anything
  // still qualifies.
  const participation = options.participation ?? null

  function archivingPermitted() {
    if (participation == null) return true
    const decision = typeof participation === 'function' ? participation() : participation
    // A ledger wired to the decision authority fails closed: until a decision
    // has actually been published, this device has not been cleared to promise
    // anyone durable storage. Pledges already held are untouched.
    if (decision == null) return false
    return decision.archiveEligible === true
  }

  let tail = Promise.resolve()
  const ready = Promise.resolve(repository?.load?.()).then(value => {
    const restored = decodeState(value, capacityBytes, options.capacityBytes !== undefined)
    reservations = restored.reservations
    capacityBytes = restored.capacityBytes
    reportCapacity()
  })

  function capacitySnapshot(source = reservations) {
    const reservedBytes = heldBytes(source)
    return {
      totalBytes: capacityBytes,
      reservedBytes,
      availableBytes: Math.max(0, capacityBytes - reservedBytes),
      observedAt: now(),
    }
  }

  function observe(method, input) {
    try { diagnostics?.[method]?.(input) } catch { /* diagnostics observers must not mask policy decisions */ }
  }

  function reportCapacity(source = reservations) {
    observe('recordCapacity', capacitySnapshot(source))
  }

  function reject(reason, requestedBytes) {
    observe('recordCapacityRejection', {
      reason,
      ...capacitySnapshot(),
      ...(Number.isSafeInteger(requestedBytes) && requestedBytes >= 0 ? { requestedBytes } : {}),
    })
    return { accepted: false, reason }
  }

  function serialize(operation) {
    const result = tail.then(async () => {
      await ready
      return operation()
    })
    tail = result.catch(() => {})
    return result
  }

  async function persist(next, nextCapacity = capacityBytes) {
    await repository?.save?.(encodeState(next, nextCapacity))
    reservations = next
    capacityBytes = nextCapacity
    reportCapacity()
  }

  return {
    ready,
    setCapacity(value) {
      return serialize(async () => {
        let nextCapacity
        try { nextCapacity = safeBytes(value, 'capacityBytes') } catch { return reject('invalid-capacity') }
        if (heldBytes(reservations) > nextCapacity) return reject('capacity-below-reservations')
        await persist(cloneReservations(reservations), nextCapacity)
        return { accepted: true, capacityBytes: nextCapacity }
      })
    },


    reserve(input = {}) {
      return serialize(async () => {
        let pledgeId
        let bytes
        let expiresAt
        let persistedPledge
        let coreRef = null
        try {
          pledgeId = reservationId(input.pledgeId)
          bytes = safeBytes(input.bytes, 'bytes', { positive: true })
          expiresAt = safeTimestamp(input.expiresAt, 'expiresAt')
          persistedPledge = pledgeEnvelope(input.pledgeEnvelope)
          if (input.coreRef && typeof input.coreRef === 'object') {
            coreRef = normalizeAssetCoreRefV2(input.coreRef)
          }
        } catch {
          return reject('invalid-reservation', Number(input.bytes))
        }
        if (expiresAt <= now()) return reject('invalid-reservation', bytes)
        const current = reservations.get(pledgeId)
        if (current) {
          if (current.reservedBytes === bytes && current.expiresAt === expiresAt) {
            return { accepted: true, pledgeId, reservedBytes: current.reservedBytes, idempotent: true }
          }
          return reject('reservation-conflict', bytes)
        }
        if (!archivingPermitted()) return reject('archiving-not-permitted', bytes)
        if (reservations.size >= MAX_RESERVATIONS) return reject('capacity-exceeded', bytes)
        if (heldBytes(reservations) + bytes > capacityBytes) return reject('capacity-exceeded', bytes)
        const next = cloneReservations(reservations)
        next.set(pledgeId, {
          pledgeId,
          reservedBytes: bytes,
          verifiedBytes: 0,
          complete: false,
          verifiedRanges: [],
          expiresAt,
          ...(coreRef ? { coreRef } : {}),
          ...(persistedPledge ? { pledgeEnvelope: persistedPledge } : {}),
        })
        await persist(next)
        return { accepted: true, pledgeId, reservedBytes: bytes, idempotent: false }
      })
    },

    reconcile(input = {}) {
      return serialize(async () => {
        let pledgeId
        let verifiedBytes
        try {
          pledgeId = reservationId(input.pledgeId)
          verifiedBytes = safeBytes(input.verifiedBytes ?? 0, 'verifiedBytes')
        } catch {
          return { accepted: false, reason: 'invalid-reconciliation' }
        }
        const current = reservations.get(pledgeId)
        if (!current) return { accepted: false, reason: 'reservation-not-found' }
        if (verifiedBytes > current.reservedBytes) {
          return { accepted: false, reason: 'reservation-exceeded' }
        }
        const maxEnd = current.coreRef ? current.coreRef.length : Number.MAX_SAFE_INTEGER
        let candidateRanges = current.verifiedRanges || []
        if (input.verifiedRanges !== undefined) {
          try {
            candidateRanges = normalizeVerifiedRanges(input.verifiedRanges, maxEnd)
          } catch {
            return { accepted: false, reason: 'invalid-verified-ranges' }
          }
        }
        const pledgedRanges = pledgedRangesFromReservation(current)
        const coverageComplete = pledgedRanges.length > 0 ? rangesCoverPledged(candidateRanges, pledgedRanges) : true
        const isComplete = input.complete === true && verifiedBytes === current.reservedBytes && verifiedBytes > 0 && coverageComplete
        const next = cloneReservations(reservations)
        const updated = next.get(pledgeId)
        updated.verifiedBytes = verifiedBytes
        updated.complete = isComplete
        updated.verifiedRanges = candidateRanges
        await persist(next)
        return {
          accepted: true,
          pledgeId,
          reservedBytes: updated.reservedBytes,
          verifiedBytes: updated.verifiedBytes,
          complete: updated.complete,
        }
      })
    },

    release(input = {}) {
      return serialize(async () => {
        let pledgeId
        try { pledgeId = reservationId(input.pledgeId) } catch { return { released: false } }
        if (!reservations.has(pledgeId)) return { released: false }
        const next = cloneReservations(reservations)
        next.delete(pledgeId)
        await persist(next)
        return { released: true, pledgeId }
      })
    },

    expire(currentTime = now()) {
      return serialize(async () => {
        const at = safeTimestamp(currentTime, 'currentTime')
        const next = cloneReservations(reservations)
        const expired = []
        for (const [pledgeId, reservation] of next) {
          if (reservation.expiresAt <= at) {
            next.delete(pledgeId)
            expired.push(pledgeId)
          }
        }
        if (expired.length > 0) await persist(next)
        else reportCapacity()
        return { expired }
      })
    },

    async snapshot() {
      await ready
      return {
        ...capacitySnapshot(),
        reservations: encodeState(reservations, capacityBytes).reservations,
      }
    },

    async availableBytes() {
      await ready
      return Math.max(0, capacityBytes - heldBytes(reservations))
    },
  }
}
