export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353

export const DNS_TYPE = Object.freeze({
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33
})

const DNS_CLASS_IN = 1
const MAX_POINTER_JUMPS = 32

export function normalizeDnsName(name) {
  const value = String(name)
  return (value.endsWith('.') ? value.slice(0, -1) : value).toLowerCase()
}

export function compareIpv4(left, right) {
  const leftOctets = String(left).split('.').map(Number)
  const rightOctets = String(right).split('.').map(Number)

  for (let i = 0; i < 4; i++) {
    const difference = leftOctets[i] - rightOctets[i]
    if (difference !== 0) return difference
  }

  return 0
}

function encodeName(name) {
  const labels = String(name).replace(/\.$/, '').split('.')
  const parts = []

  for (const label of labels) {
    const data = Buffer.from(label, 'utf8')
    if (data.length > 63) throw new RangeError('DNS labels cannot exceed 63 bytes')
    parts.push(Buffer.from([data.length]), data)
  }

  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

export function buildQuery(serviceName) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4)

  const question = Buffer.alloc(4)
  question.writeUInt16BE(DNS_TYPE.PTR, 0)
  question.writeUInt16BE(DNS_CLASS_IN, 2)

  return Buffer.concat([header, encodeName(serviceName), question])
}

function decodeName(buffer, offset, inlineLimit = buffer.length) {
  if (!Number.isInteger(offset) || !Number.isInteger(inlineLimit)) return null
  if (offset < 0 || inlineLimit < offset || inlineLimit > buffer.length) return null

  const labels = []
  const visitedPointers = new Set()
  let cursor = offset
  let limit = inlineLimit
  let nextOffset = null
  let pointerJumps = 0

  while (true) {
    if (cursor >= limit || cursor >= buffer.length) return null

    const length = buffer[cursor]

    if (length === 0) {
      if (nextOffset === null) nextOffset = cursor + 1
      return { name: labels.join('.'), offset: nextOffset }
    }

    const prefix = length & 0xc0
    if (prefix === 0xc0) {
      if (cursor + 1 >= limit || cursor + 1 >= buffer.length) return null
      if (visitedPointers.has(cursor)) return null

      visitedPointers.add(cursor)
      pointerJumps++
      if (pointerJumps > MAX_POINTER_JUMPS) return null

      const target = ((length & 0x3f) << 8) | buffer[cursor + 1]
      if (target >= buffer.length) return null

      if (nextOffset === null) nextOffset = cursor + 2
      cursor = target
      limit = buffer.length
      continue
    }

    if (prefix !== 0 || length > 63) return null

    const labelStart = cursor + 1
    const labelEnd = labelStart + length
    if (labelEnd > limit || labelEnd > buffer.length) return null

    labels.push(buffer.subarray(labelStart, labelEnd).toString('utf8'))
    cursor = labelEnd
  }
}

function decodeTypedRecord(record, buffer, rdataStart, rdataEnd) {
  const { type, rdata } = record

  if (type === DNS_TYPE.A) {
    if (rdata.length === 4) {
      record.address = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`
    }
    return
  }

  if (type === DNS_TYPE.PTR) {
    const decoded = decodeName(buffer, rdataStart, rdataEnd)
    if (decoded && decoded.offset === rdataEnd) {
      record.ptr = normalizeDnsName(decoded.name)
    }
    return
  }

  if (type === DNS_TYPE.SRV) {
    if (rdata.length < 6) return

    const decoded = decodeName(buffer, rdataStart + 6, rdataEnd)
    if (!decoded || decoded.offset !== rdataEnd) return

    record.priority = rdata.readUInt16BE(0)
    record.weight = rdata.readUInt16BE(2)
    record.port = rdata.readUInt16BE(4)
    record.target = normalizeDnsName(decoded.name)
    return
  }

  if (type === DNS_TYPE.TXT) {
    const txt = {}
    let offset = 0

    while (offset < rdata.length) {
      const length = rdata[offset]
      const end = offset + 1 + length
      if (end > rdata.length) return

      const item = rdata.subarray(offset + 1, end).toString('utf8')
      const separator = item.indexOf('=')
      if (separator > 0) txt[item.slice(0, separator)] = item.slice(separator + 1)
      offset = end
    }

    record.txt = txt
  }
}

export function parseResponse(buffer) {
  if (!buffer || buffer.length < 12) return null

  const result = {
    id: buffer.readUInt16BE(0),
    flags: buffer.readUInt16BE(2),
    qdcount: buffer.readUInt16BE(4),
    ancount: buffer.readUInt16BE(6),
    nscount: buffer.readUInt16BE(8),
    arcount: buffer.readUInt16BE(10),
    records: []
  }

  if ((result.flags & 0x8000) === 0) return null

  let offset = 12

  for (let i = 0; i < result.qdcount; i++) {
    const questionName = decodeName(buffer, offset)
    if (!questionName || questionName.offset + 4 > buffer.length) return null
    offset = questionName.offset + 4
  }

  const recordCount = result.ancount + result.nscount + result.arcount
  for (let i = 0; i < recordCount; i++) {
    const owner = decodeName(buffer, offset)
    if (!owner) return null
    offset = owner.offset

    if (offset + 10 > buffer.length) return null

    const type = buffer.readUInt16BE(offset)
    const cls = buffer.readUInt16BE(offset + 2)
    const ttl = buffer.readUInt32BE(offset + 4)
    const rdlength = buffer.readUInt16BE(offset + 8)
    const rdataStart = offset + 10
    const rdataEnd = rdataStart + rdlength
    if (rdataEnd > buffer.length) return null

    const rdata = buffer.subarray(rdataStart, rdataEnd)
    const record = {
      name: normalizeDnsName(owner.name),
      type,
      class: cls,
      ttl,
      rdata,
      dataKey: rdata.toString('hex')
    }

    decodeTypedRecord(record, buffer, rdataStart, rdataEnd)
    result.records.push(record)
    offset = rdataEnd
  }

  return result
}
