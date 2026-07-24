const PREFERRED_WIFI_INTERFACES = ['en0', 'wlan0']

function parseIPv4(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = ((result << 8) | octet) >>> 0
  }
  return result
}

function usableIPv4(record) {
  if (!record || record.internal || (record.family !== 'IPv4' && record.family !== 4)) return false
  if (record.address === '0.0.0.0' || record.address?.startsWith('127.')) return false
  return parseIPv4(record.address) !== null
}

export function selectLocalIPv4ForTarget(targetHost, interfaces = {}) {
  const candidates = []
  for (const [name, records] of Object.entries(interfaces || {})) {
    if (!Array.isArray(records)) continue
    for (const record of records) {
      if (usableIPv4(record)) candidates.push({ name, record })
    }
  }

  const target = parseIPv4(targetHost)
  if (target !== null) {
    for (const candidate of candidates) {
      const address = parseIPv4(candidate.record.address)
      const netmask = parseIPv4(candidate.record.netmask)
      if (address !== null && netmask !== null && (address & netmask) === (target & netmask)) {
        return candidate.record.address
      }
    }
  }

  for (const preferredName of PREFERRED_WIFI_INTERFACES) {
    const preferred = candidates.find((candidate) => candidate.name === preferredName)
    if (preferred) return preferred.record.address
  }

  return candidates[0]?.record.address ?? null
}
