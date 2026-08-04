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

function cloneReservations(source) {
  return new Map(Array.from(source, ([id, reservation]) => [id, { ...reservation }]))
}

function heldBytes(reservations) {
  let total = 0
  for (const reservation of reservations.values()) total += Math.max(reservation.reservedBytes, reservation.actualBytes)
  return total
}

function decodeState(value, configuredCapacityBytes, hasConfiguredCapacity) {
  const reservations = new Map()
  if (value == null) return { reservations, capacityBytes: configuredCapacityBytes }
  if (value.version !== POLICY_STATE_VERSION || !Array.isArray(value.reservations) || value.reservations.length > MAX_RESERVATIONS) {
    throw new Error('archive reservation state is invalid')
  }
  for (const raw of value.reservations) {
    const pledgeId = reservationId(raw.pledgeId)
    const reservedBytes = safeBytes(raw.reservedBytes, 'reservedBytes')
    const actualBytes = safeBytes(raw.actualBytes, 'actualBytes')
    const expiresAt = safeTimestamp(raw.expiresAt, 'expiresAt')
    const persistedPledge = pledgeEnvelope(raw.pledgeEnvelope)
    if (actualBytes > reservedBytes || reservations.has(pledgeId)) throw new Error('archive reservation state is inconsistent')
    reservations.set(pledgeId, { pledgeId, reservedBytes, actualBytes, expiresAt })
    if (persistedPledge) reservations.get(pledgeId).pledgeEnvelope = persistedPledge
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
    try { diagnostics?.[method]?.(input) } catch {}
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
        try {
          pledgeId = reservationId(input.pledgeId)
          bytes = safeBytes(input.bytes, 'bytes', { positive: true })
          expiresAt = safeTimestamp(input.expiresAt, 'expiresAt')
          persistedPledge = pledgeEnvelope(input.pledgeEnvelope)
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
          actualBytes: 0,
          expiresAt,
          ...(persistedPledge ? { pledgeEnvelope: persistedPledge } : {}),
        })
        await persist(next)
        return { accepted: true, pledgeId, reservedBytes: bytes, idempotent: false }
      })
    },

    reconcile(input = {}) {
      return serialize(async () => {
        let pledgeId
        let actualBytes
        try {
          pledgeId = reservationId(input.pledgeId)
          actualBytes = safeBytes(input.actualBytes, 'actualBytes')
        } catch {
          return { accepted: false, reason: 'invalid-reconciliation' }
        }
        const current = reservations.get(pledgeId)
        if (!current) return { accepted: false, reason: 'reservation-not-found' }
        if (actualBytes > current.reservedBytes) return { accepted: false, reason: 'reservation-exceeded' }
        const next = cloneReservations(reservations)
        const updated = next.get(pledgeId)
        updated.actualBytes = actualBytes
        if (input.complete === true) updated.reservedBytes = actualBytes
        await persist(next)
        return { accepted: true, pledgeId, reservedBytes: updated.reservedBytes, actualBytes }
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
