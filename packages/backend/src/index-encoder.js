export function encodeIndexKey(...parts) {
  return parts
    .map((part) => {
      const value = part == null ? '' : String(part)
      return `${value.length}:${value}`
    })
    .join('|')
}
