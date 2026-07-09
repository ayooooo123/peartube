import test from 'brittle'
import {
  DNS_TYPE,
  buildQuery,
  compareIpv4,
  normalizeDnsName,
  parseResponse
} from '../src/cast/mdns.js'

const SERVICE = '_googlecast._tcp.local.'
const INSTANCE = 'Kitchen TV._GoogleCast._tcp.Local.'
const TARGET = 'Kitchen-Chromecast.Local.'

function dnsName(name) {
  const labels = name.replace(/\.$/, '').split('.')
  const parts = []

  for (const label of labels) {
    const data = Buffer.from(label)
    parts.push(Buffer.from([data.length]), data)
  }

  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function record(name, type, rdata, { cls = 1, ttl = 120 } = {}) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(cls, 2)
  header.writeUInt32BE(ttl, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([dnsName(name), header, rdata])
}

function response({ answers = [], authorities = [], additionals = [] } = {}) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(authorities.length, 8)
  header.writeUInt16BE(additionals.length, 10)
  return Buffer.concat([header, ...answers, ...authorities, ...additionals])
}

function srvData(port, target) {
  const header = Buffer.alloc(6)
  header.writeUInt16BE(port, 4)
  return Buffer.concat([header, dnsName(target)])
}

function txtData(values) {
  return Buffer.concat(Object.entries(values).map(([key, value]) => {
    const item = Buffer.from(`${key}=${value}`)
    return Buffer.concat([Buffer.from([item.length]), item])
  }))
}

function pointerLoopResponse() {
  const packet = response({ answers: [Buffer.alloc(12)] })
  packet.writeUInt16BE(0xc00c, 12)
  return packet
}

function invalidOwnerResponse() {
  const invalidOwner = Buffer.concat([
    Buffer.from([0x40]),
    Buffer.alloc(64),
    Buffer.alloc(10)
  ])
  return response({ answers: [invalidOwner] })
}

function truncatedRecordResponse() {
  const rr = record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25]))
  rr.writeUInt16BE(8, dnsName(TARGET).length + 8)
  return response({ answers: [rr] })
}

function truncatedEmbeddedNameSrvData() {
  return Buffer.from([0, 0, 0, 0, 0x1f, 0x49, 4, 0x62, 0x61])
}

function truncatedTxtData() {
  return Buffer.from([5, 0x66, 0x6e, 0x3d, 0x54])
}

test('buildQuery creates one multicast PTR question without QU', (t) => {
  const packet = buildQuery(SERVICE)

  t.is(packet.readUInt16BE(4), 1)
  t.is(packet.readUInt16BE(packet.length - 4), DNS_TYPE.PTR)
  t.is(packet.readUInt16BE(packet.length - 2), 1)
})

test('parseResponse decodes all Chromecast DNS-SD record types in section order', (t) => {
  const parsed = parseResponse(response({
    answers: [record(SERVICE, DNS_TYPE.PTR, dnsName(INSTANCE))],
    authorities: [record(INSTANCE, DNS_TYPE.SRV, srvData(8009, TARGET))],
    additionals: [
      record(INSTANCE, DNS_TYPE.TXT, txtData({ fn: 'Kitchen TV', md: 'Chromecast' })),
      record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25]))
    ]
  }))

  t.is(parsed.records[0].name, normalizeDnsName(SERVICE))
  t.is(parsed.records[0].ptr, normalizeDnsName(INSTANCE))
  t.is(parsed.records[1].name, normalizeDnsName(INSTANCE))
  t.is(parsed.records[1].target, normalizeDnsName(TARGET))
  t.is(parsed.records[1].port, 8009)
  t.alike(parsed.records[2].txt, { fn: 'Kitchen TV', md: 'Chromecast' })
  t.is(parsed.records[3].address, '192.168.1.25')
  t.is(parsed.records[3].dataKey, 'c0a80119')
})

test('parseResponse rejects invalid packet framing and compression loops', (t) => {
  t.is(parseResponse(Buffer.alloc(11)), null)
  t.is(parseResponse(pointerLoopResponse()), null)
  t.is(parseResponse(truncatedRecordResponse()), null)
  t.is(parseResponse(invalidOwnerResponse()), null)
})

test('parseResponse ignores malformed SRV RDATA and continues with later records', (t) => {
  const parsed = parseResponse(response({ answers: [
    record(INSTANCE, DNS_TYPE.SRV, truncatedEmbeddedNameSrvData()),
    record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25]))
  ] }))

  t.is(parsed.records.length, 2)
  t.absent(parsed.records[0].target)
  t.absent(parsed.records[0].port)
  t.is(parsed.records[1].address, '192.168.1.25')
})

test('parseResponse ignores malformed TXT RDATA and continues with later records', (t) => {
  const parsed = parseResponse(response({ answers: [
    record(INSTANCE, DNS_TYPE.TXT, truncatedTxtData()),
    record(TARGET, DNS_TYPE.A, Buffer.from([10, 0, 0, 4]))
  ] }))

  t.is(parsed.records.length, 2)
  t.absent(parsed.records[0].txt)
  t.is(parsed.records[1].address, '10.0.0.4')
})

test('normalizes names and orders IPv4 addresses numerically', (t) => {
  t.is(normalizeDnsName('Kitchen.LOCAL.'), 'kitchen.local')
  t.ok(compareIpv4('192.168.1.2', '192.168.1.10') < 0)
  t.ok(compareIpv4('10.0.0.10', '10.0.1.1') < 0)
  t.is(compareIpv4('172.16.0.1', '172.16.0.1'), 0)
})
