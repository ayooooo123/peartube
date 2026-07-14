function invalidMatrix() {
  throw new Error('Invalid capture matrix')
}

function fail(record, source, destination, reason) {
  throw new Error(`Capture packet ${record.index} ${source} -> ${destination}: ${reason}`)
}

function validateMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object') invalidMatrix()
  if (!matrix.roles || typeof matrix.roles !== 'object') invalidMatrix()
  if (!matrix.contacts || typeof matrix.contacts !== 'object') invalidMatrix()
  if (!Array.isArray(matrix.requiredEdges)) invalidMatrix()
  const range = matrix.portRange
  if (
    !range ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 1 ||
    range.max > 65_535 ||
    range.min > range.max
  ) {
    invalidMatrix()
  }
  const phases = matrix.phases
  if (
    !phases ||
    typeof phases.captureStartedAtNs !== 'bigint' ||
    typeof phases.closedAtNs !== 'bigint' ||
    typeof phases.captureStoppedAtNs !== 'bigint' ||
    phases.captureStartedAtNs > phases.closedAtNs ||
    phases.closedAtNs > phases.captureStoppedAtNs
  ) {
    invalidMatrix()
  }
  const addresses = new Map()
  const routeRoles = new Set()
  for (const [role, value] of Object.entries(matrix.roles)) {
    if (
      !value ||
      !Array.isArray(value.addresses) ||
      value.addresses.length === 0 ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535 ||
      typeof value.route !== 'boolean'
    ) {
      invalidMatrix()
    }
    if (value.route) routeRoles.add(role)
    for (const address of value.addresses) {
      if (typeof address !== 'string' || addresses.has(address)) invalidMatrix()
      addresses.set(address, role)
    }
  }
  for (const role of routeRoles) {
    const contacts = matrix.contacts[role]
    if (!Array.isArray(contacts)) invalidMatrix()
    for (const contact of contacts) if (!routeRoles.has(contact)) invalidMatrix()
  }
  for (const edge of matrix.requiredEdges) {
    if (!Array.isArray(edge) || edge.length !== 2) invalidMatrix()
    if (!routeRoles.has(edge[0]) || !routeRoles.has(edge[1])) invalidMatrix()
    if (!matrix.contacts[edge[0]].includes(edge[1])) invalidMatrix()
  }
  return { addresses, routeRoles }
}

function checkEdge(record, source, destination, matrix, routeRoles) {
  if (
    (source === 'source' && destination === 'destination') ||
    (source === 'destination' && destination === 'source')
  ) {
    fail(record, source, destination, 'forbidden edge')
  }
  if (!routeRoles.has(destination)) fail(record, source, destination, 'forbidden edge')
  if (source === 'source' && destination !== 'safety-guard') {
    fail(record, source, destination, 'source may contact only safety-guard')
  }
  if (source === 'destination' && destination !== 'private-final') {
    fail(record, source, destination, 'destination may contact only private-final')
  }
  if (!matrix.contacts[source].includes(destination)) {
    fail(record, source, destination, 'forbidden edge')
  }
}

function checkPort(record, source, destination, matrix) {
  const ip = record.ip
  const range = matrix.portRange
  const expectedSource = matrix.roles[source].port
  const expectedDestination = matrix.roles[destination].port
  if (
    ip.sourcePort < range.min ||
    ip.sourcePort > range.max ||
    ip.destinationPort < range.min ||
    ip.destinationPort > range.max ||
    ip.sourcePort !== expectedSource ||
    ip.destinationPort !== expectedDestination
  ) {
    fail(record, source, destination, 'UDP port outside reserved role assignment')
  }
}

export function auditPrivateRouteCapture(capture, matrix) {
  if (!capture || !Array.isArray(capture.records)) throw new Error('Malformed parsed capture')
  const { addresses, routeRoles } = validateMatrix(matrix)
  const observed = new Set()
  let rolePacketCount = 0
  for (const record of capture.records) {
    if (!record || !record.ip) continue
    const source = addresses.get(record.ip.source)
    if (!source || !routeRoles.has(source)) continue
    const destination = addresses.get(record.ip.destination) || 'external'
    rolePacketCount++
    if (record.timestampNs < matrix.phases.captureStartedAtNs) {
      fail(record, source, destination, 'before capture phase')
    }
    if (record.timestampNs > matrix.phases.closedAtNs) {
      fail(record, source, destination, 'after closed phase')
    }
    if (record.ip.protocol !== 'udp') {
      fail(record, source, destination, `protocol ${record.ip.protocol}`)
    }
    checkEdge(record, source, destination, matrix, routeRoles)
    checkPort(record, source, destination, matrix)
    if (record.ip.payloadLength !== 1_200) {
      fail(record, source, destination, 'UDP payload length is not 1200')
    }
    observed.add(`${source}->${destination}`)
  }
  if (rolePacketCount === 0) throw new Error('capture is empty for private-route roles')
  for (const [source, destination] of matrix.requiredEdges) {
    if (!observed.has(`${source}->${destination}`)) {
      throw new Error(`Capture is missing required edge ${source} -> ${destination}`)
    }
  }
  return {
    packetCount: capture.records.length,
    rolePacketCount,
    observedEdges: [...observed].sort()
  }
}
