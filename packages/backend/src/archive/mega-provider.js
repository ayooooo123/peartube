import b4a from 'b4a'
import sodium from 'sodium-universal'

const MEGA_API_URL = 'https://g.api.mega.co.nz/cs'

// Mega's node type for a file. Folders are 1, and the tree fetch returns both.
const MEGA_FILE = 0

// Mega stores a node's attributes and its wrapped key as opaque strings it
// never reads, which is what lets a block key survive a relay restart: the key
// is written into the attribute field and read back out of the tree fetch. It
// is deliberately NOT Mega's own attribute format — see the note on the factory
// about what that costs.
//
// The marker carries a generation as well as the key, because `p` always
// creates: a key can legitimately have two nodes behind it, and the newest has
// to be identifiable from the marker alone rather than from the order the tree
// fetch listed them in.
const MARKER_PREFIX = 'PTB2:'
const NODE_KEY_BYTES = 32

// Mega answers a failed command with a negative integer rather than an HTTP
// status, so every code is mapped onto the status the rest of the offload path
// already understands. Without this the retry policy could not tell "come back
// later" from "this will fail forever", and hasBlock() could not recognise an
// absent block.
const MEGA_STATUS = new Map([
  [-1, 503], // EINTERNAL
  [-2, 400], // EARGS
  [-3, 429], // EAGAIN
  [-4, 429], // ERATELIMIT
  [-5, 503], // EFAILED
  [-6, 429], // ETOOMANY
  [-7, 416], // ERANGE
  [-8, 410], // EEXPIRED
  [-9, 404], // ENOENT
  [-10, 400], // ECIRCULAR
  [-11, 403], // EACCESS
  [-12, 409], // EEXIST
  [-13, 400], // EINCOMPLETE
  [-14, 400], // EKEY
  [-15, 401], // ESID
  [-16, 403], // EBLOCKED
  [-17, 507], // EOVERQUOTA
  [-18, 503] // ETEMPUNAVAIL
])

// Same policy and the same reasoning as the S3 provider: one title is hundreds
// of block requests, and every request here is idempotent because a block's
// bytes are fixed by its core and index.
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 200

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function backoffMs (attempt) {
  return (RETRY_BASE_MS * (2 ** (attempt - 1))) * (0.5 + Math.random())
}

function isRetryable (error) {
  const status = error?.statusCode
  if (status === undefined) return true // network-level: no response at all
  if (status === 408 || status === 429) return true
  return status >= 500
}

function assertString (value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function responseError (response, operation) {
  const error = new Error(`Mega ${operation} failed with HTTP ${response.status}`)
  error.statusCode = response.status
  return error
}

function apiError (code, operation) {
  const error = new Error(`Mega ${operation} failed with API error ${code}`)
  error.statusCode = MEGA_STATUS.get(code) ?? 500
  error.megaCode = code
  return error
}

// The offloader learns "this block is not there" from a 404 and nothing else, so
// a key with no node behind it has to arrive in that shape.
function absentError (key, operation) {
  const error = new Error(`Mega ${operation} failed with HTTP 404: no node for ${key}`)
  error.statusCode = 404
  return error
}

// Mega speaks base64url without padding everywhere - handles, keys and
// attributes - so this is the encoding of the whole protocol, not a detail of
// the marker. b4a has no 'base64url', and Bare's does not either, so the
// translation is done here rather than depending on a Node-only Buffer.
function base64url (bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url (text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  return b4a.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64')
}

function asBytes (data) {
  if (data === null || data === undefined) return b4a.alloc(0)
  return b4a.isBuffer(data) ? data : b4a.from(data)
}

// The one digest the offload path speaks: remote-block-store.js hands over the
// BASE64 of a raw SHA-256, and it is what a node read back has to match. Taken
// from sodium-universal rather than node:crypto so it still works under Bare -
// Hypercore's own hashes are BLAKE2b and cannot stand in for it.
function sha256Base64 (data) {
  const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, data)
  return b4a.toString(digest, 'base64')
}

/**
 * Mega archive access over Mega's public REST API.
 *
 * The interface is exactly the S3 provider's - putBlock/getBlock/hasBlock/
 * deleteBlock/getStatus - so remote-block-store.js and the offloader cannot
 * tell the two apart. Nothing Mega-shaped leaks upward: Mega addresses a file
 * by an opaque node handle, and this provider is what turns the offloader's
 * block key into that handle.
 *
 * `session` is Mega's session id (`sid`), and it is required rather than
 * derived. Turning an email and password into a session id needs AES-128-ECB
 * for the password key and RSA to unwrap the returned `csid`, and the universal
 * backend has neither - sodium-universal ships no AES at all. So the credential
 * exchange stays outside this module, exactly as SigV4 signing stays outside the
 * S3 provider, and the operator supplies a session id the same way they supply a
 * bucket key.
 *
 * A consequence of the same missing primitive: blocks are stored as the bytes
 * they were handed, and the node's key and attribute fields carry an opaque
 * marker instead of Mega's AES-wrapped forms. That is what the S3 tier already
 * does - `putBlock` there PUTs the block verbatim. What it does mean is that
 * these nodes are relay storage rather than Mega files: another Mega client
 * sees them as undecryptable. Reading them back needs this provider.
 *
 * Mega offers no server-side checksum, so `putBlock` proves the stored bytes by
 * reading the created node back before it reports success. That is not
 * belt-and-braces: the offloader deletes a local block on the strength of a
 * successful put, so presence of a node is not something this provider is
 * allowed to mistake for the right bytes being in it.
 */
export function createMegaArchiveProvider (options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  const session = assertString(options.session, 'session')
  const folder = assertString(options.folder, 'folder')
  const apiUrl = typeof options.apiUrl === 'string' && options.apiUrl.length > 0 ? options.apiUrl : MEGA_API_URL
  const config = Object.freeze({
    provider: 'mega',
    folder,
    prefix: typeof options.prefix === 'string' ? options.prefix : ''
  })

  let requests = 0
  let failures = 0
  let retries = 0
  let sequence = 0

  // A cache in front of the tree fetch, never the record of truth. The mapping
  // itself lives in Mega, in each node's attribute field, so a relay that
  // restarts - or a second relay pointed at the same folder - rebuilds it
  // without a local sidecar file to lose.
  //
  // A key maps to every node Mega holds for it, newest generation first, rather
  // than to one handle: `p` always creates, so a re-put - or a crash between
  // creating the replacement and retiring what it replaced - genuinely leaves
  // two nodes carrying the same key, and which of them is current has to be
  // decided by the marker rather than by tree-fetch order.
  const nodes = new Map()
  // The highest generation ever seen for a key, never lowered, so a generation
  // is never handed out twice even after an entry is dropped as vanished.
  const generations = new Map()
  let hydrated = false

  function getStatus () {
    // `failures` counts requests that failed for good, after retries. A blip a
    // retry absorbed is visible as `retries`, not as ill health.
    return { ...config, requests, failures, retries, healthy: failures === 0 }
  }

  // One retry policy for everything this provider issues. It has to wrap the
  // body as well as the response, because Mega reports "come back later" as a
  // negative code in a 200 body far more often than as an HTTP status: a policy
  // that only looked at the status would never retry an EAGAIN, and an archive
  // of hundreds of blocks hits those.
  async function attempts (run) {
    requests++
    for (let n = 1; ; n++) {
      try {
        return await run()
      } catch (error) {
        if (n >= MAX_ATTEMPTS || !isRetryable(error)) {
          failures++
          throw error
        }
        retries++
        await sleep(backoffMs(n))
      }
    }
  }

  async function fetchOnce (operation, url, init = {}) {
    const response = await fetchImpl(url, init)
    if (!response.ok) throw responseError(response, operation)
    return response
  }

  const transfer = (operation, url, init) => attempts(() => fetchOnce(operation, url, init))

  // Mega answers a command batch with either a bare negative integer, which
  // failed the whole batch, or an array of per-command results that can each be
  // a negative integer of their own. Both arrive as HTTP 200, so the body has to
  // be inspected before it can be treated as a result. The sequence id advances
  // per attempt, which is what Mega expects of a resent request.
  async function commandOnce (operation, body) {
    const url = `${apiUrl}?id=${sequence++}&sid=${encodeURIComponent(session)}`
    const response = await fetchOnce(operation, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([body])
    })
    const payload = await response.json()
    const result = Array.isArray(payload) ? payload[0] : payload
    if (typeof result === 'number') {
      if (result < 0) throw apiError(result, operation)
      return result
    }
    // `g` reports a per-file refusal inside the object rather than in place of
    // it, which is how an expired or removed node arrives.
    if (result && typeof result.e === 'number' && result.e < 0) throw apiError(result.e, operation)
    return result
  }

  const command = (operation, body) => attempts(() => commandOnce(operation, body))

  // The file server answers a completed upload with a completion token and a
  // failed one with a negative code in the body, so the same inspection applies
  // here. A resend posts the whole block to the same ticket at offset 0 again,
  // which is exactly what a ticket is for.
  async function uploadOnce (target, bytes) {
    const response = await fetchOnce('put', `${target}/0`, { method: 'POST', body: bytes })
    const token = (await response.text()).trim()
    if (/^-\d+$/.test(token)) throw apiError(Number(token), 'put')
    if (token.length === 0) {
      const error = new Error('Mega put failed: the upload returned no completion token')
      error.statusCode = 502
      throw error
    }
    return token
  }

  // The generation rides in the marker next to the key, which is what makes
  // duplicate resolution deterministic: the highest generation holds the newest
  // bytes, whether or not the retirement that should have followed the create
  // ever ran, and the handle breaks a tie so two relays reading the same folder
  // resolve a key identically.
  const markerFor = (key, generation) => base64url(b4a.from(`${MARKER_PREFIX}${generation}:${key}`))

  function parseMarker (attribute) {
    if (typeof attribute !== 'string' || attribute.length === 0) return null
    let decoded
    try {
      decoded = b4a.toString(fromBase64url(attribute), 'utf8')
    } catch {
      return null
    }
    if (!decoded.startsWith(MARKER_PREFIX)) return null
    const body = decoded.slice(MARKER_PREFIX.length)
    const split = body.indexOf(':')
    if (split <= 0) return null
    const generation = Number(body.slice(0, split))
    const key = body.slice(split + 1)
    if (!Number.isSafeInteger(generation) || generation < 0 || key.length === 0) return null
    return { key, generation }
  }

  function precedence (a, b) {
    if (a.generation !== b.generation) return b.generation - a.generation
    return a.handle < b.handle ? -1 : 1
  }

  function track (key, entry) {
    const seen = generations.get(key)
    if (seen === undefined || seen < entry.generation) generations.set(key, entry.generation)
    const list = nodes.get(key)
    if (!list) {
      nodes.set(key, [entry])
      return
    }
    if (list.some(known => known.handle === entry.handle)) return
    list.push(entry)
    list.sort(precedence)
  }

  // Only the node list forgets a handle. `generations` deliberately does not, so
  // a node that vanished under us cannot hand its generation out a second time.
  function drop (key, handle) {
    const list = nodes.get(key)
    if (!list) return
    const kept = list.filter(entry => entry.handle !== handle)
    if (kept.length === 0) nodes.delete(key)
    else nodes.set(key, kept)
  }

  const nextGeneration = (key) => generations.has(key) ? generations.get(key) + 1 : 0

  /**
   * Mega has no per-folder listing: the tree fetch returns the whole account in
   * one response. That is why it runs at most once per provider, on the first
   * key that is not already cached, rather than per lookup.
   */
  async function hydrate () {
    if (hydrated) return
    const tree = await command('list', { a: 'f', c: 1 })
    for (const node of Array.isArray(tree?.f) ? tree.f : []) {
      if (node?.t !== MEGA_FILE || node?.p !== folder) continue
      if (typeof node.h !== 'string' || node.h.length === 0) continue
      const marker = parseMarker(node.a)
      if (marker === null) continue
      track(marker.key, { handle: node.h, generation: marker.generation })
    }
    hydrated = true
  }

  async function resolveHandle (key) {
    const cached = nodes.get(key)
    if (cached && cached.length > 0) return cached[0].handle
    await hydrate()
    const list = nodes.get(key)
    return list && list.length > 0 ? list[0].handle : null
  }

  // A node that is already gone is the outcome a delete wanted, so it counts as
  // success and is un-counted as a failure - the offloader retries a delete
  // after a crash and a second attempt must not read as a fault. Any other
  // refusal is real and is reported.
  async function remove (handle, operation) {
    try {
      await command(operation, { a: 'd', n: handle })
    } catch (error) {
      if (error.statusCode !== 404) throw error
      failures--
    }
  }

  // A node whose stored bytes could not be proved must not survive the failed
  // put: it carries the newest generation for the key, so leaving it behind is
  // exactly the ambiguity the generation exists to remove. If it cannot be
  // removed the put still fails - the local block is what keeps the media alive
  // either way - but the reason then says both things went wrong.
  async function discard (handle, key, reason) {
    try {
      await remove(handle, 'put')
    } catch (error) {
      const failed = new Error(`${reason}, and the unproved node ${handle} for ${key} could not be removed: ${error.message}`)
      failed.statusCode = error.statusCode ?? 502
      throw failed
    }
  }

  // Mega has no server-side checksum: an upload cannot be handed a digest to
  // enforce, and no command reports the digest of a node Mega holds. So proving
  // the stored bytes means reading them back - one `g` command for a transfer
  // URL, then the download - and that round trip is paid on every put
  // deliberately. What it buys is the deletion boundary: the offloader drops the
  // local block on the strength of a successful put, so a put that reported
  // success on node creation alone turned a truncated or corrupted upload into
  // permanent media loss, found only by a merkle mismatch long after the last
  // good copy was gone.
  async function proveStored (handle, key, bytes, expected) {
    const ticket = await command('put', { a: 'g', g: 1, n: handle })
    const target = assertString(ticket?.g, 'the transfer URL Mega returned')
    const response = await transfer('put', target)
    const stored = b4a.from(await response.arrayBuffer())
    // The caller's checksum is the authority when there is one - it is what the
    // merkle tree upstream committed to - and the digest of the bytes handed
    // over stands in when there is not, so there is no path on which a put
    // reports success without the stored bytes having been checked against
    // something.
    const want = typeof expected === 'string' && expected.length > 0 ? expected : sha256Base64(bytes)
    if (sha256Base64(stored) === want) return
    const reason = `Mega put failed: ${key} did not land with the SHA-256 it was sent with`
    await discard(handle, key, reason)
    // Counted after the removal, because removing a node that was already gone
    // un-counts a failure of its own and must not cancel this one.
    failures++
    const error = new Error(reason)
    error.statusCode = 422
    throw error
  }

  return {
    getStatus,

    /**
     * `checksumSha256Base64` is the BASE64 of the raw SHA-256 digest, the same
     * wire format the S3 provider documents, and it is what the stored bytes are
     * proved against before this reports success. Mega cannot be handed it on
     * upload, so the created node is read back and compared; when the caller
     * supplies no checksum the digest of the bytes handed over is used instead.
     * The existence of a node is never accepted as proof of anything: the
     * offloader deletes the local block on a successful put, and that local
     * block is the last good copy.
     */
    async putBlock ({ key, data, checksumSha256Base64 } = {}) {
      assertString(key, 'key')
      const bytes = asBytes(data)
      // The tree fetch before the upload is what crash safety costs, and it is
      // paid once per provider. Without it a relay that restarted would not know
      // a node already exists for this key: it would write generation 0 into a
      // folder that already holds generation 3, and the next hydrate would bind
      // the key to the stale node.
      await hydrate()
      const superseded = [...(nodes.get(key) || [])]
      const generation = nextGeneration(key)
      const ticket = await command('put', { a: 'u', s: bytes.byteLength })
      const target = assertString(ticket?.p, 'the upload URL Mega returned')
      // One POST for the whole block: the offloader holds a single block at a
      // time, so it is in memory already and Mega accepts an arbitrary offset
      // as long as the bytes add up to the size the ticket was cut for.
      const token = await attempts(() => uploadOnce(target, bytes))
      const created = await command('put', {
        a: 'p',
        t: folder,
        n: [{ h: token, t: MEGA_FILE, a: markerFor(key, generation), k: base64url(b4a.alloc(NODE_KEY_BYTES)) }]
      })
      const handle = created?.f?.[0]?.h
      if (typeof handle !== 'string' || handle.length === 0) {
        failures++
        const error = new Error('Mega put failed: the created node has no handle')
        error.statusCode = 502
        throw error
      }
      await proveStored(handle, key, bytes, checksumSha256Base64)
      // Tracked before anything is retired, so a retirement that fails leaves a
      // mapping that is still true rather than one that has forgotten the node
      // it just wrote. The new generation is the highest, so it is current.
      track(key, { handle, generation })
      // Retiring what this put replaced is part of the put, not an afterthought
      // to swallow: the caller deletes its local block on a successful put, and
      // a folder this could not tidy is a folder whose state it does not know.
      // The generation ordering is what makes a failure here safe rather than
      // corrupting - the newest node still wins on the next hydrate - and the
      // next put for this key retries the retirement.
      for (const entry of superseded) {
        if (entry.handle === handle) continue
        await remove(entry.handle, 'put')
        drop(key, entry.handle)
      }
      return { success: true, key }
    },

    /**
     * Mega's file servers take a range as a path suffix on the transfer URL -
     * `<url>/<start>-<end>`, both ends inclusive - not as an HTTP `Range`
     * header. The end is required, which is why the transfer ticket's size is
     * used when the caller leaves it open: restore-on-read asks for one block
     * out of a larger object and must not pull the whole object back.
     */
    async getBlock ({ key, range } = {}) {
      assertString(key, 'key')
      const handle = await resolveHandle(key)
      if (!handle) throw absentError(key, 'get')
      let ticket
      try {
        ticket = await command('get', { a: 'g', g: 1, n: handle })
      } catch (error) {
        // A cached handle Mega no longer knows means the node was removed
        // behind our back; forget it so the next read looks it up again.
        if (error.statusCode === 404) drop(key, handle)
        throw error
      }
      const target = assertString(ticket?.g, 'the transfer URL Mega returned')
      const size = Number(ticket?.s)
      let url = target
      if (range) {
        const end = range.end ?? (Number.isFinite(size) ? size - 1 : undefined)
        if (end === undefined) {
          failures++
          const error = new Error(`Mega get failed: ${key} has no known size to bound an open range with`)
          error.statusCode = 502
          throw error
        }
        url = `${target}/${range.start}-${end}`
      }
      const response = await transfer('get', url)
      return response.arrayBuffer()
    },

    /**
     * A block that is not there is a normal answer, not a provider fault, so it
     * leaves `getStatus().healthy` true. The S3 provider had exactly this bug -
     * every absent block marked the whole tier unhealthy - and it is not being
     * reintroduced here.
     */
    async hasBlock ({ key } = {}) {
      assertString(key, 'key')
      const handle = await resolveHandle(key)
      if (!handle) return false
      try {
        await command('head', { a: 'g', g: 1, n: handle })
        return true
      } catch (error) {
        if (error.statusCode === 404) {
          failures--
          drop(key, handle)
          return false
        }
        throw error
      }
    },

    /**
     * Deleting a key that is already gone succeeds, matching S3's DELETE. The
     * offloader retries a delete after a crash, and a second attempt must not be
     * reported as a failure.
     */
    async deleteBlock ({ key } = {}) {
      assertString(key, 'key')
      await hydrate()
      // Every node carrying the key goes, not only the current one: a stale
      // duplicate left behind makes a deleted key reappear on the next restart,
      // bound to bytes nothing has verified.
      for (const entry of [...(nodes.get(key) || [])]) {
        await remove(entry.handle, 'delete')
        drop(key, entry.handle)
      }
      nodes.delete(key)
      return { success: true, key }
    }
  }
}
