import test from 'brittle'
import { DeviceDiscoverer, ServiceType } from '../src/cast/discovery.js'

const INSTANCE = 'Kitchen TV._googlecast._tcp.local.'
const TARGET = 'kitchen-chromecast.local.'

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

function completeChromecastPacket() {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(8009, 4)
  const txt = Buffer.from('fn=Kitchen TV')
  const records = [
    record(ServiceType.CHROMECAST, 12, dnsName(INSTANCE)),
    record(INSTANCE, 33, Buffer.concat([srv, dnsName(TARGET)])),
    record(INSTANCE, 16, Buffer.concat([Buffer.from([txt.length]), txt])),
    record(TARGET, 1, Buffer.from([192, 168, 1, 25]))
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

test('complete Chromecast packet still populates idle discoverer state', (t) => {
  const discoverer = new DeviceDiscoverer()

  discoverer._handleMessage(completeChromecastPacket())

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})
