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
//
// A browse asks only once, when it starts. A peer announces itself on its own
// only for about its first 55 minutes: bonjour-service sends at 0, 3, 12 and
// 39 s and so on, each wait three times the last, the final one at 3279 s.
// After that it only answers queries. Wi-Fi does not resend a lost multicast
// frame, so a phone that misses an answer can wait until some other host asks.
// The browse therefore starts over every `rebrowse` ms, which asks again;
// hyperdht-mdns skips services it has just seen. Each new browse starts before
// the last one stops, so the shared mDNS socket stays open in between.
export function selfAddressAdapter (host, inner = new HyperDHTmDNS.BonjourAdapter(), { rebrowse = 10_000 } = {}) {
  return {
    advertise (record, handlers) {
      return inner.advertise({ ...record, txt: { ...record.txt, h: host } }, handlers)
    },
    browse (query, handlers) {
      const onService = service => {
        const h = String(service?.txt?.h || '')
        handlers.onService(isIPv4(h) ? { ...service, referer: null, addresses: [h] } : service)
      }
      const wrapped = { ...handlers, onService }
      let current = inner.browse(query, wrapped)
      const timer = setInterval(async () => {
        try {
          const previous = current
          current = inner.browse(query, wrapped)
          await (await previous).stop()
        } catch (err) {
          handlers.onError?.(err)
        }
      }, rebrowse)
      timer.unref?.()
      return {
        async stop () {
          clearInterval(timer)
          await (await current).stop()
        }
      }
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
