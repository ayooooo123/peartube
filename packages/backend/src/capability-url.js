const SENSITIVE_QUERY_KEY = /(?:^|[_-])(access[_-]?)?(?:token|authorization|signature|secret|credential)(?:$|[_-])/i
const RELATIVE_URL_BASE = 'http://capability.invalid'

export function redactCapabilityUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return '[redacted-url]'

  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    const parsed = new URL(value, RELATIVE_URL_BASE)
    const segments = parsed.pathname.split('/')
    const castSegment = segments.indexOf('cast')
    if (castSegment >= 0 && segments[castSegment + 1]) {
      segments[castSegment + 1] = '***'
      parsed.pathname = segments.join('/')
    }

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '***')
    }

    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'

    return isAbsolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '[redacted-url]'
  }
}
