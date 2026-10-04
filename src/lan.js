import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { Bonjour } from 'bonjour-service'
import { isIPv4 } from 'node:net'

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

// A device's own LAN address: the first private IPv4 on Android's Wi-Fi
// (wlan*), else on an en* or eth* interface (Wi-Fi or Ethernet on macOS and
// iOS, Ethernet elsewhere). Cellular, VPN and loopback interfaces can carry
// private addresses too, but no LAN peer can reach them; the Android emulator
// even names its cellular link eth0. interfaces is os.networkInterfaces().
export function lanAddress (interfaces) {
  const names = Object.keys(interfaces).filter(name => /^(wl|en|eth)/.test(name))
  for (const name of names.sort((a, b) => b.startsWith('wl') - a.startsWith('wl'))) {
    for (const { family, address, internal } of interfaces[name]) {
      if ((family === 'IPv4' || family === 4) && !internal && PRIVATE.test(address)) return address
    }
  }
  return null
}

// hyperdht-mdns dials the address the mDNS packet came from. Behind an mDNS
// reflector (a router bridging subnets) that is the router, not the peer. Each
// peer therefore advertises the address its LAN DHT is bound to (TXT `h`),
// and that address wins over the packet's sender.
export function selfAddressAdapter (host, inner = new HyperDHTmDNS.BonjourAdapter()) {
  return {
    advertise (record, handlers) {
      return inner.advertise({ ...record, txt: { ...record.txt, h: host } }, handlers)
    },
    browse (query, handlers) {
      const onService = service => {
        const h = String(service?.txt?.h || '')
        handlers.onService(isIPv4(h) ? { ...service, referer: null, addresses: [h] } : service)
      }
      return inner.browse(query, { ...handlers, onService })
    }
  }
}

// selfAddressAdapter with mDNS kept on host's interface. A phone has Wi-Fi,
// cellular and often a VPN up at once, and the default route for multicast
// need not be the Wi-Fi. The socket still binds to all addresses: one bound to
// host would receive no multicast.
export function interfaceAdapter (host) {
  const createBonjour = onError => new Bonjour({ interface: host, bind: '0.0.0.0' }, onError)
  return selfAddressAdapter(host, new HyperDHTmDNS.BonjourAdapter({ createBonjour }))
}

// LAN discovery without the internet or a port forward: an isolated,
// bootstrap-free HyperDHT that finds peers over mDNS. Discovery errors are
// reported, never thrown: an unhandled 'error' would kill the whole relay.
export function createLan ({ host, port = 49799, keyPair, adapter = selfAddressAdapter(host) }) {
  const lan = new HyperDHTmDNS({ host, port, keyPair, adapter })
  lan.on('error', err => console.error(JSON.stringify({ msg: 'lan discovery error', error: err?.message || String(err) })))
  lan.on('warning', () => {})
  return lan
}
