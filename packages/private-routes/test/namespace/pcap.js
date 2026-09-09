import b4a from 'b4a'

const LINKTYPE_ETHERNET = 1
const LINKTYPE_LINUX_SLL2 = 276
const ETHER_TYPE_IPV4 = 0x0800
const ETHER_TYPE_IPV6 = 0x86dd
const VLAN_TYPES = new Set([0x8100, 0x88a8])

function malformed(reason) {
  throw new Error(`Malformed PCAP: ${reason}`)
}

function readUInt16(buffer, offset, byteOrder) {
  return byteOrder === 'little' ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
}

function readUInt32(buffer, offset, byteOrder) {
  return byteOrder === 'little' ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

function magic(buffer) {
  const value = b4a.toString(buffer.subarray(0, 4), 'hex')
  switch (value) {
    case 'd4c3b2a1':
      return { byteOrder: 'little', timestampResolution: 'microseconds' }
    case 'a1b2c3d4':
      return { byteOrder: 'big', timestampResolution: 'microseconds' }
    case '4d3cb2a1':
      return { byteOrder: 'little', timestampResolution: 'nanoseconds' }
    case 'a1b23c4d':
      return { byteOrder: 'big', timestampResolution: 'nanoseconds' }
    default:
      malformed('unsupported magic')
  }
}

function ipv4Address(buffer, offset) {
  return `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`
}

function ipv6Address(buffer, offset) {
  const groups = []
  for (let index = 0; index < 8; index++) {
    groups.push(buffer.readUInt16BE(offset + index * 2).toString(16))
  }
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0') {
      index++
      continue
    }
    let end = index + 1
    while (end < groups.length && groups[end] === '0') end++
    if (end - index > bestLength) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }
  if (bestLength < 2) return groups.join(':')
  const left = groups.slice(0, bestStart).join(':')
  const right = groups.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

function transport(protocolNumber, payload, version) {
  if (protocolNumber === 17) {
    if (payload.byteLength < 8) malformed('truncated UDP header')
    const length = payload.readUInt16BE(4)
    if (length < 8 || length !== payload.byteLength) malformed('invalid UDP length')
    return {
      fields: {
        protocol: 'udp',
        protocolNumber,
        sourcePort: payload.readUInt16BE(0),
        destinationPort: payload.readUInt16BE(2),
        payloadLength: length - 8
      },
      payload: payload.subarray(8, length)
    }
  }
  if (protocolNumber === 6) {
    if (payload.byteLength < 20) malformed('truncated TCP header')
    const headerLength = (payload[12] >> 4) << 2
    if (headerLength < 20 || headerLength > payload.byteLength) malformed('invalid TCP length')
    return {
      fields: {
        protocol: 'tcp',
        protocolNumber,
        sourcePort: payload.readUInt16BE(0),
        destinationPort: payload.readUInt16BE(2),
        payloadLength: payload.byteLength - headerLength
      },
      payload: payload.subarray(headerLength)
    }
  }
  if (protocolNumber === 1 && version === 4) {
    if (payload.byteLength < 4) malformed('truncated ICMP header')
    return {
      fields: { protocol: 'icmp', protocolNumber, payloadLength: payload.byteLength - 4 },
      payload: payload.subarray(4)
    }
  }
  if (protocolNumber === 58 && version === 6) {
    if (payload.byteLength < 4) malformed('truncated ICMPv6 header')
    return {
      fields: { protocol: 'icmpv6', protocolNumber, payloadLength: payload.byteLength - 4 },
      payload: payload.subarray(4)
    }
  }
  return {
    fields: { protocol: `ip-${protocolNumber}`, protocolNumber, payloadLength: payload.byteLength },
    payload
  }
}

function parseIpv4(buffer) {
  if (buffer.byteLength < 20) malformed('truncated IPv4 header')
  if (buffer[0] >> 4 !== 4) malformed('invalid IPv4 version')
  const headerLength = (buffer[0] & 0x0f) << 2
  if (headerLength < 20 || headerLength > buffer.byteLength) malformed('invalid IPv4 header length')
  const totalLength = buffer.readUInt16BE(2)
  if (totalLength < headerLength || totalLength > buffer.byteLength)
    malformed('invalid IPv4 length')
  if ((buffer.readUInt16BE(6) & 0x3fff) !== 0) malformed('IPv4 fragment')
  const protocolNumber = buffer[9]
  const decoded = transport(protocolNumber, buffer.subarray(headerLength, totalLength), 4)
  return {
    ip: {
      version: 4,
      source: ipv4Address(buffer, 12),
      destination: ipv4Address(buffer, 16),
      ...decoded.fields
    },
    transportPayload: decoded.payload
  }
}

function parseIpv6(buffer) {
  if (buffer.byteLength < 40) malformed('truncated IPv6 header')
  if (buffer[0] >> 4 !== 6) malformed('invalid IPv6 version')
  const payloadLength = buffer.readUInt16BE(4)
  const totalLength = 40 + payloadLength
  if (totalLength > buffer.byteLength) malformed('invalid IPv6 length')
  const protocolNumber = buffer[6]
  const decoded = transport(protocolNumber, buffer.subarray(40, totalLength), 6)
  return {
    ip: {
      version: 6,
      source: ipv6Address(buffer, 8),
      destination: ipv6Address(buffer, 24),
      ...decoded.fields
    },
    transportPayload: decoded.payload
  }
}

function parseEthernet(buffer) {
  if (buffer.byteLength < 14) malformed('truncated Ethernet header')
  let offset = 14
  let etherType = buffer.readUInt16BE(12)
  const vlanTags = []
  while (VLAN_TYPES.has(etherType)) {
    if (vlanTags.length === 2) malformed('too many VLAN tags')
    if (buffer.byteLength < offset + 4) malformed('truncated VLAN header')
    vlanTags.push(buffer.readUInt16BE(offset) & 0x0fff)
    etherType = buffer.readUInt16BE(offset + 2)
    offset += 4
  }
  let network = { ip: null, transportPayload: null }
  if (etherType === ETHER_TYPE_IPV4) network = parseIpv4(buffer.subarray(offset))
  else if (etherType === ETHER_TYPE_IPV6) network = parseIpv6(buffer.subarray(offset))
  return { ethernet: { etherType, vlanTags }, ...network }
}

function parseLinuxCookedV2(buffer) {
  if (buffer.byteLength < 20) malformed('truncated Linux SLL2 header')
  const protocol = buffer.readUInt16BE(0)
  const interfaceIndex = buffer.readUInt32BE(4)
  if (buffer[11] > 8) malformed('invalid Linux SLL2 address length')
  let network = { ip: null, transportPayload: null }
  if (protocol === ETHER_TYPE_IPV4) network = parseIpv4(buffer.subarray(20))
  else if (protocol === ETHER_TYPE_IPV6) network = parseIpv6(buffer.subarray(20))
  return { linuxCooked: { protocol, interfaceIndex }, ...network }
}

export function parsePcap(buffer) {
  if (!b4a.isBuffer(buffer)) malformed('capture must be a buffer')
  if (buffer.byteLength < 24) malformed('truncated global header')
  const { byteOrder, timestampResolution } = magic(buffer)
  if (readUInt16(buffer, 4, byteOrder) !== 2 || readUInt16(buffer, 6, byteOrder) !== 4) {
    malformed('unsupported version')
  }
  const snaplen = readUInt32(buffer, 16, byteOrder)
  if (snaplen === 0) malformed('invalid snap length')
  const linkType = readUInt32(buffer, 20, byteOrder)
  if (linkType !== LINKTYPE_ETHERNET && linkType !== LINKTYPE_LINUX_SLL2) {
    malformed('unsupported link type')
  }
  const records = []
  let offset = 24
  while (offset < buffer.byteLength) {
    if (buffer.byteLength - offset < 16) malformed('truncated record header')
    const seconds = readUInt32(buffer, offset, byteOrder)
    const fraction = readUInt32(buffer, offset + 4, byteOrder)
    const capturedLength = readUInt32(buffer, offset + 8, byteOrder)
    const originalLength = readUInt32(buffer, offset + 12, byteOrder)
    const fractionLimit = timestampResolution === 'microseconds' ? 1_000_000 : 1_000_000_000
    if (fraction >= fractionLimit) malformed('invalid timestamp fraction')
    if (capturedLength > snaplen) malformed('record exceeds snap length')
    if (originalLength < capturedLength) malformed('original length is shorter than capture')
    if (originalLength !== capturedLength) malformed('truncated record payload')
    offset += 16
    if (buffer.byteLength - offset < capturedLength) malformed('truncated record payload')
    const bytes = buffer.subarray(offset, offset + capturedLength)
    const parsed = linkType === LINKTYPE_ETHERNET ? parseEthernet(bytes) : parseLinuxCookedV2(bytes)
    const multiplier = timestampResolution === 'microseconds' ? 1_000n : 1n
    records.push({
      index: records.length,
      timestampNs: BigInt(seconds) * 1_000_000_000n + BigInt(fraction) * multiplier,
      capturedLength,
      originalLength,
      ...parsed
    })
    offset += capturedLength
  }
  return { byteOrder, timestampResolution, snaplen, linkType, records }
}
