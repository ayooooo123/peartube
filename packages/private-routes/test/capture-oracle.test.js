import test from 'brittle'
import b4a from 'b4a'

import {
  auditNegativeControlCapture,
  auditPrivateRouteCapture
} from './namespace/capture-oracle.js'
import { parsePcap } from './namespace/pcap.js'

const NS_PER_SECOND = 1_000_000_000n

const ROLE_ORDER = Object.freeze([
  'source',
  'safety-guard',
  'safety-final',
  'private-entry',
  'private-middle',
  'private-final',
  'destination'
])

const CONTACTS = Object.freeze({
  source: Object.freeze(['safety-guard']),
  'safety-guard': Object.freeze(['source', 'safety-final']),
  'safety-final': Object.freeze(['safety-guard', 'private-entry']),
  'private-entry': Object.freeze(['safety-final', 'private-middle']),
  'private-middle': Object.freeze(['private-entry', 'private-final']),
  'private-final': Object.freeze(['private-middle', 'destination']),
  destination: Object.freeze(['private-final'])
})

function writeUInt16(buffer, value, offset, endian) {
  if (endian === 'little') buffer.writeUInt16LE(value, offset)
  else buffer.writeUInt16BE(value, offset)
}

function writeUInt32(buffer, value, offset, endian) {
  if (endian === 'little') buffer.writeUInt32LE(value, offset)
  else buffer.writeUInt32BE(value, offset)
}

function ipv4Bytes(address) {
  return b4a.from(address.split('.').map((value) => Number(value)))
}

function ipv6Bytes(address) {
  const [leftValue, rightValue] = address.split('::')
  const left = leftValue ? leftValue.split(':') : []
  const right = rightValue ? rightValue.split(':') : []
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(
    (value) => Number.parseInt(value || '0', 16)
  )
  const result = b4a.alloc(16)
  for (let index = 0; index < groups.length; index++) result.writeUInt16BE(groups[index], index * 2)
  return result
}

function udp(sourcePort, destinationPort, payloadLength = 1_200) {
  const result = b4a.alloc(8 + payloadLength, 0x71)
  result.writeUInt16BE(sourcePort, 0)
  result.writeUInt16BE(destinationPort, 2)
  result.writeUInt16BE(result.byteLength, 4)
  result.writeUInt16BE(0, 6)
  return result
}

function tcp(sourcePort, destinationPort, payloadLength = 3) {
  const result = b4a.alloc(20 + payloadLength, 0x52)
  result.writeUInt16BE(sourcePort, 0)
  result.writeUInt16BE(destinationPort, 2)
  result[12] = 5 << 4
  return result
}

function icmp(payloadLength = 4) {
  const result = b4a.alloc(4 + payloadLength, 0x34)
  result[0] = 8
  return result
}

function ipv4(options) {
  const transport = options.transport
  const result = b4a.alloc(20 + transport.byteLength)
  result[0] = 0x45
  result.writeUInt16BE(result.byteLength, 2)
  result.writeUInt16BE(options.fragment || 0, 6)
  result[8] = 64
  result[9] = options.protocol
  ipv4Bytes(options.source).copy(result, 12)
  ipv4Bytes(options.destination).copy(result, 16)
  transport.copy(result, 20)
  return result
}

function ipv6(options) {
  const transport = options.transport
  const result = b4a.alloc(40 + transport.byteLength)
  result[0] = 0x60
  result.writeUInt16BE(transport.byteLength, 4)
  result[6] = options.protocol
  result[7] = 64
  ipv6Bytes(options.source).copy(result, 8)
  ipv6Bytes(options.destination).copy(result, 24)
  transport.copy(result, 40)
  return result
}

function ethernet(network, etherType, vlan = null) {
  const headerLength = vlan === null ? 14 : 18
  const result = b4a.alloc(headerLength + network.byteLength)
  b4a.alloc(6, 0x11).copy(result, 0)
  b4a.alloc(6, 0x22).copy(result, 6)
  if (vlan === null) {
    result.writeUInt16BE(etherType, 12)
  } else {
    result.writeUInt16BE(0x8100, 12)
    result.writeUInt16BE(vlan, 14)
    result.writeUInt16BE(etherType, 16)
  }
  network.copy(result, headerLength)
  return result
}

function record(bytes, timestampNs, originalLength = bytes.byteLength) {
  return { bytes, timestampNs, originalLength }
}

function pcap(records, options = {}) {
  const endian = options.endian || 'little'
  const header = b4a.alloc(24)
  const magic =
    endian === 'little' ? b4a.from([0xd4, 0xc3, 0xb2, 0xa1]) : b4a.from([0xa1, 0xb2, 0xc3, 0xd4])
  magic.copy(header)
  writeUInt16(header, 2, 4, endian)
  writeUInt16(header, 4, 6, endian)
  writeUInt32(header, options.snaplen || 65_535, 16, endian)
  writeUInt32(header, options.linkType === undefined ? 1 : options.linkType, 20, endian)
  const encoded = [header]
  for (const value of records) {
    const recordHeader = b4a.alloc(16)
    const seconds = value.timestampNs / NS_PER_SECOND
    const micros = (value.timestampNs % NS_PER_SECOND) / 1_000n
    writeUInt32(recordHeader, Number(seconds), 0, endian)
    writeUInt32(recordHeader, Number(micros), 4, endian)
    writeUInt32(recordHeader, value.bytes.byteLength, 8, endian)
    writeUInt32(recordHeader, value.originalLength, 12, endian)
    encoded.push(recordHeader, value.bytes)
  }
  return b4a.concat(encoded)
}

function roles() {
  const result = {}
  for (let index = 0; index < ROLE_ORDER.length; index++) {
    result[ROLE_ORDER[index]] = Object.freeze({
      addresses: Object.freeze([`10.77.0.${index + 2}`, `fd00::${index + 2}`]),
      port: 48_100 + index,
      route: true
    })
  }
  result.decoy = Object.freeze({
    addresses: Object.freeze(['10.77.0.9', 'fd00::9']),
    port: 49_999,
    route: false
  })
  result.auditor = Object.freeze({
    addresses: Object.freeze(['10.77.0.10', 'fd00::10']),
    port: 48_250,
    route: false
  })
  return Object.freeze(result)
}

const ROLES = roles()
const REQUIRED_EDGES = Object.freeze(
  ROLE_ORDER.flatMap((source) => CONTACTS[source].map((destination) => [source, destination]))
)
const MATRIX = Object.freeze({
  roles: ROLES,
  contacts: CONTACTS,
  portRange: Object.freeze({ min: 48_100, max: 48_106 }),
  requiredEdges: REQUIRED_EDGES,
  phases: Object.freeze({
    captureStartedAtNs: 9n * NS_PER_SECOND,
    closedAtNs: 20n * NS_PER_SECOND,
    captureStoppedAtNs: 30n * NS_PER_SECOND
  })
})

function routePacket(source, destination, options = {}) {
  const sourceRecord = ROLES[source]
  const destinationRecord = ROLES[destination]
  const sourceAddress = options.sourceAddress || sourceRecord.addresses[0]
  const destinationAddress = options.destinationAddress || destinationRecord.addresses[0]
  const sourcePort = options.sourcePort || sourceRecord.port
  const destinationPort = options.destinationPort || destinationRecord.port
  const protocol = options.protocol === undefined ? 17 : options.protocol
  const transport =
    options.transport ||
    (protocol === 17
      ? udp(sourcePort, destinationPort, options.payloadLength)
      : protocol === 6
        ? tcp(sourcePort, destinationPort)
        : icmp())
  const network = sourceAddress.includes(':')
    ? ipv6({ source: sourceAddress, destination: destinationAddress, protocol, transport })
    : ipv4({ source: sourceAddress, destination: destinationAddress, protocol, transport })
  return record(
    ethernet(network, sourceAddress.includes(':') ? 0x86dd : 0x0800, options.vlan),
    options.timestampNs || 10n * NS_PER_SECOND
  )
}

function validRecords() {
  return REQUIRED_EDGES.map(([source, destination], index) =>
    routePacket(source, destination, {
      timestampNs: 10n * NS_PER_SECOND + BigInt(index) * 1_000n
    })
  )
}

function failure(t, records, pattern, matrix = MATRIX) {
  let error = null
  try {
    auditPrivateRouteCapture(parsePcap(pcap(records)), matrix)
  } catch (cause) {
    error = cause
  }
  t.ok(error, pattern)
  if (!error) return
  t.ok(pattern.test(error.message), error.message)
  t.absent(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(error.message), 'redacts IPv4 addresses')
  t.absent(/[0-9a-f]{0,4}:[0-9a-f:]+/i.test(error.message), 'redacts IPv6 addresses')
}

function sentinelPacket(kind, timestampNs) {
  const payload = b4a.alloc(32, kind === 'start' ? 0xa1 : 0xa2)
  const transport = udp(ROLES.decoy.port, ROLES.auditor.port, payload.byteLength)
  payload.copy(transport, 8)
  return routePacket('decoy', 'auditor', { transport, timestampNs })
}

const SENTINEL_MATRIX = Object.freeze({
  ...MATRIX,
  sentinels: Object.freeze({
    start: Object.freeze({
      source: 'decoy',
      destination: 'auditor',
      sourcePort: ROLES.decoy.port,
      destinationPort: ROLES.auditor.port,
      payload: b4a.alloc(32, 0xa1),
      sentAtNs: 9n * NS_PER_SECOND,
      receivedAtNs: 10n * NS_PER_SECOND
    }),
    stop: Object.freeze({
      source: 'decoy',
      destination: 'auditor',
      sourcePort: ROLES.decoy.port,
      destinationPort: ROLES.auditor.port,
      payload: b4a.alloc(32, 0xa2),
      sentAtNs: 29n * NS_PER_SECOND,
      receivedAtNs: 30n * NS_PER_SECOND
    })
  })
})

test('negative-control preflight capture proves the exact source-to-decoy capability', async (t) => {
  const payload = b4a.alloc(32, 0xa7)
  const transport = udp(48_150, ROLES.decoy.port, payload.byteLength)
  payload.copy(transport, 8)
  const capture = parsePcap(
    pcap([
      routePacket('source', 'decoy', {
        sourcePort: 48_150,
        transport,
        timestampNs: 10n * NS_PER_SECOND
      })
    ])
  )
  t.alike(
    auditNegativeControlCapture(capture, {
      source: ROLES.source.addresses[0],
      sourcePort: 48_150,
      destination: ROLES.decoy.addresses[0],
      destinationPort: ROLES.decoy.port,
      payload
    }),
    { packetIndex: 0 }
  )
  await t.exception.all(
    () =>
      auditNegativeControlCapture(parsePcap(pcap([])), {
        source: ROLES.source.addresses[0],
        sourcePort: 48_150,
        destination: ROLES.decoy.addresses[0],
        destinationPort: ROLES.decoy.port,
        payload
      }),
    /negative-control packet is missing/
  )
})

test('classic PCAP parser handles byte order, VLAN, IPv4, IPv6, and transports', (t) => {
  const little = parsePcap(
    pcap([
      routePacket('source', 'safety-guard', { vlan: 37 }),
      routePacket('safety-guard', 'source', { protocol: 6 }),
      routePacket('source', 'safety-guard', { protocol: 1 })
    ])
  )
  t.is(little.byteOrder, 'little')
  t.is(little.timestampResolution, 'microseconds')
  t.is(little.linkType, 1)
  t.is(little.records.length, 3)
  t.alike(little.records[0].ethernet.vlanTags, [37])
  t.alike(little.records[0].ip, {
    version: 4,
    source: '10.77.0.2',
    destination: '10.77.0.3',
    protocol: 'udp',
    protocolNumber: 17,
    sourcePort: 48_100,
    destinationPort: 48_101,
    payloadLength: 1_200
  })
  t.alike(little.records[0].transportPayload, b4a.alloc(1_200, 0x71))
  t.is(little.records[1].ip.protocol, 'tcp')
  t.is(little.records[1].ip.payloadLength, 3)
  t.is(little.records[2].ip.protocol, 'icmp')

  const big = parsePcap(
    pcap(
      [
        routePacket('source', 'safety-guard', {
          sourceAddress: ROLES.source.addresses[1],
          destinationAddress: ROLES['safety-guard'].addresses[1]
        }),
        routePacket('safety-guard', 'source', {
          sourceAddress: ROLES['safety-guard'].addresses[1],
          destinationAddress: ROLES.source.addresses[1],
          protocol: 6
        }),
        routePacket('source', 'safety-guard', {
          sourceAddress: ROLES.source.addresses[1],
          destinationAddress: ROLES['safety-guard'].addresses[1],
          protocol: 58
        })
      ],
      { endian: 'big' }
    )
  )
  t.is(big.byteOrder, 'big')
  t.alike(
    big.records.map((value) => value.ip.protocol),
    ['udp', 'tcp', 'icmpv6']
  )
  t.is(big.records[0].ip.source, 'fd00::2')
  t.is(big.records[0].ip.destination, 'fd00::3')
})

test('classic PCAP parser rejects unknown links, truncation, fragments, and malformed lengths', (t) => {
  const packet = routePacket('source', 'safety-guard')
  t.exception(() => parsePcap(pcap([packet], { linkType: 101 })), /link type/)
  const truncated = pcap([packet]).subarray(0, -1)
  t.exception(() => parsePcap(truncated), /truncated/)
  t.exception(
    () => parsePcap(pcap([record(packet.bytes, packet.timestampNs, packet.bytes.byteLength - 1)])),
    /original length/
  )
  const malformed = b4a.from(packet.bytes)
  malformed.writeUInt16BE(65_535, 14 + 2)
  t.exception(() => parsePcap(pcap([record(malformed, packet.timestampNs)])), /IPv4 length/)
  const fragmented = routePacket('source', 'safety-guard')
  fragmented.bytes.writeUInt16BE(0x2000, 14 + 6)
  t.exception(() => parsePcap(pcap([fragmented])), /fragment/)
})

test('capture oracle accepts only a non-vacuous exact adjacent fixed-cell matrix', (t) => {
  const result = auditPrivateRouteCapture(parsePcap(pcap(validRecords())), MATRIX)
  t.alike(result, {
    packetCount: REQUIRED_EDGES.length,
    rolePacketCount: REQUIRED_EDGES.length,
    observedEdges: REQUIRED_EDGES.map(([source, destination]) => `${source}->${destination}`).sort()
  })
})

test('capture oracle rejects empty and missing-edge captures', (t) => {
  failure(t, [], /capture is empty/)
  failure(t, validRecords().slice(1), /missing required edge source -> safety-guard/)
})

test('capture oracle rejects every non-UDX role-originated packet', (t) => {
  failure(
    t,
    [routePacket('source', 'safety-guard', { destinationPort: 53 })],
    /packet 0 source -> safety-guard: UDP port/
  )
  failure(
    t,
    [routePacket('source', 'safety-guard', { protocol: 6 })],
    /packet 0 source -> safety-guard: protocol tcp/
  )
  failure(
    t,
    [routePacket('source', 'safety-guard', { protocol: 1 })],
    /packet 0 source -> safety-guard: protocol icmp/
  )
  failure(
    t,
    [routePacket('source', 'safety-guard', { destinationPort: 48_099 })],
    /packet 0 source -> safety-guard: UDP port/
  )
  failure(
    t,
    [routePacket('source', 'safety-guard', { payloadLength: 1_199 })],
    /packet 0 source -> safety-guard: UDP payload length/
  )
  failure(
    t,
    [
      routePacket('source', 'safety-guard', {
        sourceAddress: ROLES.source.addresses[1],
        destinationAddress: 'ff02::2',
        protocol: 58
      })
    ],
    /packet 0 source -> external: protocol icmpv6/
  )
})

test('capture oracle rejects decoy, external, direct, and endpoint-bypass edges', (t) => {
  failure(t, [routePacket('source', 'decoy')], /packet 0 source -> decoy: forbidden edge/)
  failure(
    t,
    [
      routePacket('source', 'decoy', {
        destinationAddress: '203.0.113.20',
        destinationPort: 48_101
      })
    ],
    /packet 0 source -> external: forbidden edge/
  )
  failure(
    t,
    [routePacket('source', 'destination')],
    /packet 0 source -> destination: forbidden edge/
  )
  failure(
    t,
    [routePacket('source', 'private-entry')],
    /packet 0 source -> private-entry: source may contact only safety-guard/
  )
  failure(
    t,
    [routePacket('destination', 'private-middle')],
    /packet 0 destination -> private-middle: destination may contact only private-final/
  )
})

test('capture oracle rejects role traffic outside the measured phase', (t) => {
  const afterClose = validRecords()
  afterClose[afterClose.length - 1] = routePacket('destination', 'private-final', {
    timestampNs: 21n * NS_PER_SECOND
  })
  failure(t, afterClose, /packet 11 destination -> private-final: after closed phase/)

  const beforeStart = validRecords()
  beforeStart[0] = routePacket('source', 'safety-guard', {
    timestampNs: 8n * NS_PER_SECOND
  })
  failure(t, beforeStart, /packet 0 source -> safety-guard: before capture phase/)
})

test('capture oracle requires ordered flushed sentinels aligned to coordinator time', (t) => {
  const records = [
    sentinelPacket('start', 9_500_000_000n),
    ...validRecords(),
    sentinelPacket('stop', 29_500_000_000n)
  ]
  const result = auditPrivateRouteCapture(parsePcap(pcap(records)), SENTINEL_MATRIX)
  t.alike(result.sentinels, { start: 0, stop: 13 })

  failure(t, records.slice(1), /capture start sentinel is missing/, SENTINEL_MATRIX)
  failure(t, records.slice(0, -1), /capture stop sentinel is missing/, SENTINEL_MATRIX)
  failure(
    t,
    [records.at(-1), ...validRecords(), records[0]],
    /capture sentinels are out of order/,
    SENTINEL_MATRIX
  )
  const outsideWindow = [...records]
  outsideWindow[0] = sentinelPacket('start', 8_500_000_000n)
  failure(t, outsideWindow, /capture start sentinel is outside coordinator window/, SENTINEL_MATRIX)
})
