const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Traffic classes.
 *
 * `media-loopback` is the local blob server handing already-authorized
 * Hypercore bytes to the platform player over the loopback interface. It is a
 * pipe, not an origin: it can only expose blocks this device already holds, and
 * it has no path that fetches media from the network.
 *
 * `control-plane` is everything that is deliberately allowed to leave the
 * device and is not media: signed manifests, artwork, provider authentication,
 * and DRM license requests. These are separately classified precisely so
 * "no HTTP media" cannot be quietly satisfied by relabelling media as metadata.
 *
 * `forbidden-origin` is any other HTTP(S) endpoint. Strict P2P means media
 * bytes never come from one, so reaching this class is a contract violation.
 */
export const PLAYBACK_TRAFFIC_CLASSES = Object.freeze({
  mediaLoopback: 'media-loopback',
  controlPlane: 'control-plane',
  forbiddenOrigin: 'forbidden-origin',
})

const CONTROL_PLANE_PURPOSES = new Set(['manifest', 'artwork', 'authentication', 'license', 'diagnostics'])

function parseUrl(value) {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase())
}

/**
 * Classify one URL. `purpose` names why the request is being made; only the
 * purposes in `CONTROL_PLANE_PURPOSES` may be non-loopback, and none of them
 * may carry media bytes.
 */
export function classifyPlaybackTraffic(url, purpose = 'media') {
  const parsed = parseUrl(url)
  if (!parsed) return PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin
  // Scheme first: a non-HTTP endpoint is never allowed, whatever it claims to
  // be for. Otherwise `file://` or `ftp://` could ride in as a "license".
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin
  if (purpose !== 'media' && CONTROL_PLANE_PURPOSES.has(purpose)) return PLAYBACK_TRAFFIC_CLASSES.controlPlane
  return isLoopbackHost(parsed.hostname)
    ? PLAYBACK_TRAFFIC_CLASSES.mediaLoopback
    : PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin
}

/**
 * Fail loudly when a playback URL points anywhere but the local blob server.
 *
 * This is a contract breach rather than a viewer-facing condition, so it throws
 * instead of resolving to a bounded playback error: a build that can hand the
 * player a publisher origin must not start, let alone degrade quietly.
 */
export function assertLoopbackPlaybackUrl(url, context = 'playback url') {
  const classification = classifyPlaybackTraffic(url, 'media')
  if (classification === PLAYBACK_TRAFFIC_CLASSES.mediaLoopback) return url
  throw new Error(`${context} must stay on the loopback blob server, refusing ${classification}: ${url}`)
}
