import test from 'brittle'
import { CastContext } from '../src/cast/index.js'
import { DNS_TYPE } from '../src/cast/mdns.js'

const SERVICE = '_googlecast._tcp.local.'
const INSTANCE = 'Discovered TV._googlecast._tcp.local.'
const TARGET = 'discovered-tv.local.'
const ID = '192.168.1.25:8009'

function dnsName(name) {
  const parts = []
  for (const label of name.replace(/\.$/, '').split('.')) {
    const data = Buffer.from(label)
    parts.push(Buffer.from([data.length]), data)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function record(name, type, rdata) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(1, 2)
  header.writeUInt32BE(120, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([dnsName(name), header, rdata])
}

function discoveredPacket(address = '192.168.1.25') {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(8009, 4)
  const name = Buffer.from('fn=Discovered TV')
  const records = [
    record(SERVICE, DNS_TYPE.PTR, dnsName(INSTANCE)),
    record(INSTANCE, DNS_TYPE.SRV, Buffer.concat([srv, dnsName(TARGET)])),
    record(INSTANCE, DNS_TYPE.TXT, Buffer.concat([Buffer.from([name.length]), name])),
    record(TARGET, DNS_TYPE.A, Buffer.from(address.split('.').map(Number)))
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

function addressPacket(address) {
  const addressRecord = record(
    TARGET,
    DNS_TYPE.A,
    Buffer.from(address.split('.').map(Number))
  )
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(1, 6)
  return Buffer.concat([header, addressRecord])
}

function devicesById(devices) {
  return [...devices].sort((left, right) => left.id.localeCompare(right.id))
}

test('removing an idle manual collision reveals the discovered device in context', (t) => {
  const context = new CastContext()
  context._discoverer._handleMessage(discoveredPacket(), {})

  context.addManualDevice({ name: 'Manual TV', host: '192.168.1.25' })
  context.removeManualDevice(ID)

  t.is(context.getDevices().length, 1)
  t.is(context.getDevice(ID)?.manual, undefined)
  t.is(context.getDevice(ID)?.name, 'Discovered TV')
})

test('removing an idle manual device without discovery deletes the context mirror', (t) => {
  const context = new CastContext()

  context.addManualDevice({ name: 'Manual TV', host: '192.168.1.80' })
  context.removeManualDevice('192.168.1.80:8009')

  t.alike(context.getDevices(), [])
  t.absent(context.getDevice('192.168.1.80:8009'))
})

test('removing an active manual collision forwards one discovered reveal', (t) => {
  const context = new CastContext()
  const changed = []
  context.on('deviceChanged', device => changed.push(device))
  context._discoverer._state = 'running'
  context._discoverer._handleMessage(discoveredPacket(), {})
  context.addManualDevice({ name: 'Manual TV', host: '192.168.1.25' })
  changed.length = 0

  context.removeManualDevice(ID)

  t.is(changed.length, 1)
  t.is(changed[0]?.manual, undefined)
  t.is(changed[0]?.name, 'Discovered TV')
  t.is(context.getDevices().length, 1)
  t.is(context.getDevice(ID)?.manual, undefined)
  t.is(context.getDevice(ID)?.name, 'Discovered TV')
})

test('active reentrant discovery keeps the context mirror synchronized', (t) => {
  const context = new CastContext()
  context._discoverer._state = 'running'
  context._discoverer._handleMessage(discoveredPacket('192.168.1.20'), {})
  context.on('deviceLost', id => {
    if (id === '192.168.1.20:8009') {
      context.addManualDevice({ name: 'Manual TV', host: '192.168.1.80' })
    }
  })

  context._discoverer._handleMessage(addressPacket('192.168.1.9'), {})

  t.alike(
    devicesById(context.getDevices()),
    devicesById(context._discoverer.getDevices())
  )
  t.ok(context.getDevice('192.168.1.9:8009'))
  t.ok(context.getDevice('192.168.1.80:8009'))
})
