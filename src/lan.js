import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { isIPv4 } from 'node:net'

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

// LAN discovery without the internet or a port forward: an isolated,
// bootstrap-free HyperDHT that finds peers over mDNS.
export function createLan ({ host, port = 49799, keyPair }) {
  return new HyperDHTmDNS({ host, port, keyPair, adapter: selfAddressAdapter(host) })
}
