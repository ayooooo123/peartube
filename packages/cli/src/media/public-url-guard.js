import { lookup as systemLookup } from '#dns'

// Whether a URL is safe for the relay to fetch on a stranger's behalf.
//
// A caller that hands the relay a URL is asking it to make a request from
// inside a network the caller is not in. That is server-side request forgery,
// and the relay's machine API is unauthenticated, so the guard has to be the
// thing standing in the way rather than the operator's firewall.
//
// What is refused, and why each one is here rather than "obviously fine":
//
//   non-http(s) schemes   file:, gopher:, data: — a fetch of the relay's own
//                         disk or a parser the HTTP client never meant to speak
//   embedded credentials  http://user:pass@host — the userinfo is sent to
//                         whatever the host turns out to be, and it is the
//                         oldest way to make a URL read as one host and resolve
//                         to another
//   loopback              the relay's own admin surfaces, which are
//                         unauthenticated precisely because they are local
//   link-local            169.254/16 and fe80::/10 — where cloud instance
//                         metadata (and its credentials) live
//   private and CGNAT     10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 —
//                         the operator's LAN, which is the whole point of
//                         running a relay behind one
//   multicast, reserved,  not a fetchable origin under any reading, so allowing
//   unspecified           them only widens what the HTTP client can be aimed at
//
// Hostnames are RESOLVED and every returned address is checked. Checking the
// literal alone is no guard at all: `internal.example.com A 127.0.0.1` is one
// zone edit, and it is the form this attack is usually delivered in.
//
// Public CDNs — which is what a debrid provider hands out — are unaffected by
// all of the above, so the guard costs the intended caller nothing.

export const URL_INVALID = 'INVALID_SOURCE_URL'
export const URL_SCHEME_NOT_ALLOWED = 'SOURCE_SCHEME_NOT_ALLOWED'
export const URL_CREDENTIALS_NOT_ALLOWED = 'SOURCE_CREDENTIALS_NOT_ALLOWED'
export const URL_HOST_NOT_PUBLIC = 'SOURCE_HOST_NOT_PUBLIC'
export const URL_HOST_UNRESOLVABLE = 'SOURCE_HOST_UNRESOLVABLE'

export class PublicUrlError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicUrlError'
    this.code = code
  }
}

// A URL long enough to be a denial of service on the parser is not a URL
// anyone meant to send.
const MAX_URL_LENGTH = 2048

const BLOCKED_IPV4 = [
  ['0.0.0.0', 8, 'the unspecified 0.0.0.0/8 block'],
  ['10.0.0.0', 8, 'a private RFC1918 address'],
  ['100.64.0.0', 10, 'a carrier-grade NAT RFC6598 address'],
  ['127.0.0.0', 8, 'a loopback address'],
  ['169.254.0.0', 16, 'a link-local address'],
  ['172.16.0.0', 12, 'a private RFC1918 address'],
  ['192.0.0.0', 24, 'an IETF protocol assignment'],
  ['192.168.0.0', 16, 'a private RFC1918 address'],
  ['198.18.0.0', 15, 'a benchmarking address'],
  ['224.0.0.0', 4, 'a multicast address'],
  ['240.0.0.0', 4, 'a reserved address']
]

function ipv4ToInt(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value * 256) + octet
  }
  return value
}

function ipv4Reason(address) {
  const value = ipv4ToInt(address)
  // Unparseable is refused rather than allowed: a form this does not recognise
  // is a form it cannot vouch for.
  if (value === null) return 'an unrecognized IPv4 address'
  for (const [base, bits, reason] of BLOCKED_IPV4) {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
    if (((value & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return reason
  }
  return null
}

// Expand any IPv6 text form into its eight 16-bit groups, including the
// `::ffff:1.2.3.4` mixed form the URL parser can hand back.
function ipv6Groups(address) {
  let text = String(address)
  const halves = text.split('::')
  if (halves.length > 2) return null

  const expandDottedTail = (part) => {
    const pieces = part.split(':')
    const tail = pieces[pieces.length - 1]
    if (!tail || !tail.includes('.')) return pieces
    const value = ipv4ToInt(tail)
    if (value === null) return null
    pieces.pop()
    pieces.push(((value >>> 16) & 0xffff).toString(16), (value & 0xffff).toString(16))
    return pieces
  }

  const toGroups = (part) => {
    if (part === '') return []
    const pieces = expandDottedTail(part)
    if (!pieces) return null
    const groups = []
    for (const piece of pieces) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      groups.push(Number.parseInt(piece, 16))
    }
    return groups
  }

  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...new Array(fill).fill(0), ...tail]
}

function embeddedIpv4(high, low) {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function ipv6Reason(address) {
  const groups = ipv6Groups(address)
  if (!groups) return 'an unrecognized IPv6 address'
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups

  if (groups.every((group) => group === 0)) return 'the unspecified :: address'
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'a loopback address'
  }
  // A v4 address wearing a v6 hat reaches exactly the same host, so it is
  // judged as the v4 address it carries. ::ffff:0:0/96 is what the URL parser
  // produces for `::ffff:127.0.0.1`; 64:ff9b::/96 is NAT64; 2002::/16 is 6to4;
  // and the deprecated ::/96 compatible form still routes.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4Reason(embeddedIpv4(g6, g7))
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4Reason(embeddedIpv4(g6, g7))
  }
  if (g0 === 0x2002) {
    const reason = ipv4Reason(embeddedIpv4(g1, g2))
    if (reason) return reason
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'a unique-local fc00::/7 address'
  if ((g0 & 0xffc0) === 0xfe80) return 'a link-local fe80::/10 address'
  if ((g0 & 0xff00) === 0xff00) return 'a multicast address'
  return null
}

// Why this address may not be fetched, or null when it is a public one.
export function blockedAddressReason(address) {
  const text = String(address || '').trim().replace(/^\[|\]$/g, '')
  if (!text) return 'an empty address'
  // A zone index (fe80::1%eth0) names an interface on this machine.
  const [bare] = text.split('%')
  return bare.includes(':') ? ipv6Reason(bare) : ipv4Reason(bare)
}

// The address a hostname already is, or null when it is a name to resolve.
function addressLiteral(hostname) {
  if (hostname.startsWith('[')) return hostname.replace(/^\[|\]$/g, '')
  return /^[0-9.]+$/.test(hostname) ? hostname : null
}

// Shape checks only — everything decidable without touching the network, so a
// caller's obvious mistake is refused before the relay spends a DNS query.
export function parsePublicHttpUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) throw new PublicUrlError(URL_INVALID, 'a source url is required')
  if (raw.length > MAX_URL_LENGTH) {
    throw new PublicUrlError(URL_INVALID, `a source url must be at most ${MAX_URL_LENGTH} characters`)
  }
  let url = null
  try {
    url = new URL(raw)
  } catch {
    throw new PublicUrlError(URL_INVALID, `${JSON.stringify(raw)} is not a url`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicUrlError(
      URL_SCHEME_NOT_ALLOWED,
      `a source url must be http or https, not ${url.protocol.replace(/:$/, '')}`
    )
  }
  if (url.username || url.password) {
    throw new PublicUrlError(URL_CREDENTIALS_NOT_ALLOWED, 'a source url must not carry embedded credentials')
  }
  if (!url.hostname) throw new PublicUrlError(URL_INVALID, 'a source url must name a host')
  const literal = addressLiteral(url.hostname)
  if (literal) {
    const reason = blockedAddressReason(literal)
    if (reason) {
      throw new PublicUrlError(URL_HOST_NOT_PUBLIC, `${literal} is ${reason}, which the relay will not fetch`)
    }
  }
  return url
}

function resolveAll(hostname, lookup) {
  return new Promise((resolve, reject) => {
    try {
      lookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
          reject(new PublicUrlError(URL_HOST_UNRESOLVABLE, `${hostname} could not be resolved: ${err.message || err}`))
          return
        }
        resolve((Array.isArray(addresses) ? addresses : []).map((entry) => entry?.address).filter(Boolean))
      })
    } catch (err) {
      reject(new PublicUrlError(URL_HOST_UNRESOLVABLE, `${hostname} could not be resolved: ${err?.message || err}`))
    }
  })
}

// The full check: shape, then every address the name resolves to.
export async function assertPublicHttpUrl(value, { lookup = systemLookup } = {}) {
  const url = parsePublicHttpUrl(value)
  if (addressLiteral(url.hostname)) return url
  if (typeof lookup !== 'function') {
    throw new PublicUrlError(URL_HOST_UNRESOLVABLE, `${url.hostname} could not be resolved: no resolver available`)
  }
  const addresses = await resolveAll(url.hostname, lookup)
  if (addresses.length === 0) {
    throw new PublicUrlError(URL_HOST_UNRESOLVABLE, `${url.hostname} resolved to no addresses`)
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address)
    if (reason) {
      throw new PublicUrlError(
        URL_HOST_NOT_PUBLIC,
        `${url.hostname} resolves to ${address}, which is ${reason}, so the relay will not fetch it`
      )
    }
  }
  return url
}
