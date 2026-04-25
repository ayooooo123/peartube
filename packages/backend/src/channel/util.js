import b4a from 'b4a'

export function toHex(key) {
  if (!key) return null
  if (typeof key === 'string') return key
  return b4a.toString(key, 'hex')
}

export function fromHex(hex) {
  if (!hex) return null
  if (b4a.isBuffer(hex)) return hex
  return b4a.from(hex, 'hex')
}

export function prefixedKey(prefix, id) {
  return id ? `${prefix}/${id}` : prefix
}


