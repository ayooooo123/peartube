// Which hosts the relay may fetch a pasted or fed URL from (direct acquisitions, feeds, identification). Link-local
// (169.254.0.0/16, fe80::/10: cloud metadata) is always refused. Loopback, private, CGNAT, unspecified, multicast
// and reserved addresses are refused unless the host opts in with PEARTUBE_ALLOW_PRIVATE_URLS=1 (a NAS on the LAN,
// local test suites). Names are checked after DNS resolution, at connect time, so a name that resolves to a refused
// address is refused too. Relay-only: the apps' worklet never imports this.
import { lookup as dnsLookup } from 'node:dns'
import { ipv6Groups } from './protocol.js'

const flag = s => s === '1' || s === 'true'
export const privateUrlsAllowed = () => flag(globalThis.process?.env?.PEARTUBE_ALLOW_PRIVATE_URLS)

function ipv4Parts (ip) {
  const parts = ip.split('.')
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  return parts.map(Number)
}

function v4Reason (a, b) {
  if (a === 169 && b === 254) return 'link-local'
  if (a === 127) return 'loopback'
  if (a === 0) return 'unspecified'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  if (a >= 224) return 'reserved'
  return null
}

// Why an address is refused ('link-local', 'loopback', 'private', …), or null when it may be fetched.
export function addressReason (ip) {
  const v4 = ipv4Parts(String(ip))
  if (v4) return v4Reason(v4[0], v4[1])
  const g = ipv6Groups(ip)
  if (!g) return 'invalid'
  // NAT64 well-known prefix (64:ff9b::/96, RFC 6052), IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses are their IPv4 address.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Reason(g[6] >> 8, g[6] & 0xff)
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] || g[7] > 1)))) return v4Reason(g[6] >> 8, g[6] & 0xff)
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'
  if (g.slice(0, 7).every(x => x === 0)) return g[7] === 1 ? 'loopback' : 'unspecified'
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'
  if ((g[0] & 0xff00) === 0xff00) return 'reserved'
  return null
}

const refused = (ip, allowPrivate) => {
  const reason = addressReason(ip)
  return reason && (reason === 'link-local' || reason === 'invalid' || !allowPrivate) ? reason : null
}
const refusal = (host, reason) => Object.assign(new Error(`Refusing to fetch from ${host}: ${reason} address`), { code: 'ERR_SSRF', status: 403 })

// Throws for a URL whose host is a refused IP literal; a name is checked when it resolves (`lookup` below).
export function checkUrlHost (u, allowPrivate) {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!ipv4Parts(host) && !ipv6Groups(host)) return
  const reason = refused(host, allowPrivate)
  if (reason) throw refusal(host, reason)
}

// A drop-in `lookup` for http(s).request (Node and bare-tcp both pass it to the socket): every resolved address
// must pass, so a name that resolves to a refused address never connects.
export function guardedLookup (allowPrivate) {
  return function lookup (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    dnsLookup(host, { family: opts?.family || 0, all: true }, (err, addresses) => {
      if (err) return cb(err)
      const list = Array.isArray(addresses) ? addresses : []
      if (!list.length) return cb(Object.assign(new Error(`No address for ${host}`), { code: 'ENOTFOUND' }))
      for (const { address } of list) {
        const reason = refused(address, allowPrivate)
        if (reason) return cb(refusal(host, reason))
      }
      if (opts?.all) cb(null, list)
      else cb(null, list[0].address, list[0].family)
    })
  }
}
