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

function discoveredPacket() {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(8009, 4)
  const name = Buffer.from('fn=Discovered TV')
  const records = [
    record(SERVICE, DNS_TYPE.PTR, dnsName(INSTANCE)),
    record(INSTANCE, DNS_TYPE.SRV, Buffer.concat([srv, dnsName(TARGET)])),
    record(INSTANCE, DNS_TYPE.TXT, Buffer.concat([Buffer.from([name.length]), name])),
    record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25]))
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
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
