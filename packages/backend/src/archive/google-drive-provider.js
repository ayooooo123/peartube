import b4a from 'b4a'
import sodium from 'sodium-universal'

// Drive's own API hosts are deliberately NOT defaulted here. This repository
// forbids a remote origin in production source — see the anti-centralization
// guard in packages/backend/test — because a relay that ships pointing at
// somebody's service by default is no longer permissionless. The operator's
// config supplies them (packages/cli carries the Google defaults, which is
// runtime configuration rather than a source default), and pointing a relay at
// a compatible endpoint is then an operator decision rather than ours.

// Drive answers 400 to a multipart upload whose whole body — metadata plus
// media — is over 5 MiB, and asks for the resumable endpoint instead. The
// cutover is a property of the API, not a tuning knob, so it is not an option.
const MULTIPART_LIMIT = 5 * 1024 * 1024

const MULTIPART_BOUNDARY = 'peartube-block-offload'

// Same policy as the S3 provider: archiving one title is hundreds of block
// requests, and Drive answers 500/503 often enough that a single blip must not
// fail a whole archive. Every request this provider issues is idempotent — a
// block's bytes are fixed by its core and index — so a retry can never write
// something other than what the first attempt would have written.
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 200

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function backoffMs (attempt) {
  // Exponential with jitter, so a relay retrying many blocks at once does not
  // resend them all on the same beat.
  return (RETRY_BASE_MS * (2 ** (attempt - 1))) * (0.5 + Math.random())
}

function assertString (value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function responseError (response, operation) {
  const error = new Error(`Google Drive ${operation} failed with HTTP ${response.status}`)
  error.statusCode = response.status
  return error
}

// The offloader only ever learns "this block is not there" through a 404, so a
// key with no file behind it has to arrive in that shape rather than as some
// provider-specific absence.
function absentError (key, operation) {
  const error = new Error(`Google Drive ${operation} failed with HTTP 404: no file named ${key}`)
  error.statusCode = 404
  return error
}

// Drive's `q` grammar is a string language, and a block key is attacker-visible
// only in the sense that it is generated from a core key — but an unescaped
// quote would still turn a lookup into a different query, so it is escaped.
function quoteForQuery (value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function asBytes (data) {
  if (data === null || data === undefined) return b4a.alloc(0)
  return b4a.isBuffer(data) ? data : b4a.from(data)
}

// The one digest the offload path speaks: remote-block-store.js hands over the
// BASE64 of a raw SHA-256, and Drive reports the digest of what it stored as
// hex, so the two are compared in this form. Taken from sodium-universal rather
// than node:crypto so it still works under Bare.
function sha256Base64 (data) {
  const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, data)
  return b4a.toString(digest, 'base64')
}

// Drive reports `sha256Checksum` as lowercase hex. A value that is not hex at
// all decodes to something that cannot match, which fails the put - the right
// direction for anything unrecognised at this boundary.
function hexToBase64 (hex) {
  return b4a.toString(b4a.from(hex, 'hex'), 'base64')
}

/**
 * Google Drive archive access over the Drive v3 REST API.
 *
 * The interface is exactly the S3 provider's — putBlock/getBlock/hasBlock/
 * deleteBlock/getStatus — so remote-block-store.js and the offloader cannot
 * tell the two apart. Nothing Drive-shaped leaks upward: Drive addresses a file
 * by an opaque id, and this provider is what turns the offloader's block key
 * into that id.
 *
 * OAuth stays outside, the way signing stays outside the S3 provider, so this
 * works in Bare and desktop runtimes without a Google SDK. Pass `accessToken`
 * for a fixed token, or `getAccessToken` when the token has to be refreshed —
 * an archive takes longer than an access token lives, so a long run needs the
 * latter.
 *
 * Drive's create is not idempotent — a POST it commits whose response is lost
 * comes back as a second file with the same name — and Drive cannot be handed a
 * checksum to enforce on upload. Both are handled in `putBlock`: the digest of
 * the stored bytes is always checked, and the duplicate set for a name is
 * always reconciled against the id whose bytes were proved. Neither is
 * optional, because the offloader deletes the local block on a successful put.
 */
export function createGoogleDriveArchiveProvider (options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  const getAccessToken = typeof options.getAccessToken === 'function' ? options.getAccessToken : null
  const staticToken = typeof options.accessToken === 'string' ? options.accessToken : ''
  if (!getAccessToken && !staticToken) throw new TypeError('accessToken or getAccessToken is required')
  const folderId = assertString(options.folderId, 'folderId')
  const filesEndpoint = assertString(options.filesEndpoint, 'filesEndpoint')
  const uploadEndpoint = assertString(options.uploadEndpoint, 'uploadEndpoint')
  const config = Object.freeze({
    provider: 'google-drive',
    folderId,
    prefix: typeof options.prefix === 'string' ? options.prefix : ''
  })

  let requests = 0
  let failures = 0
  let retries = 0
  let token = staticToken

  // A cache in front of a lookup by name, never the record of truth. Drive can
  // always be asked again, so a relay that restarts — or a second relay reading
  // the same folder — finds every id it needs without a local sidecar file to
  // lose. That is also why the block key is the file's name: the mapping lives
  // in Drive.
  const ids = new Map()
  // Keys a lookup saw more than one file for. Two files with one name is what a
  // lost create response or a crash mid-put leaves behind, and the next put for
  // the key is what clears it.
  const duplicates = new Set()

  function getStatus () {
    // `failures` counts requests that failed for good, after retries. A blip a
    // retry absorbed is visible as `retries`, not as ill health.
    return { ...config, requests, failures, retries, healthy: failures === 0 }
  }

  // A stale access token is the one 4xx worth retrying, and only when there is
  // somewhere to get a fresh one from.
  function isRetryable (error) {
    const status = error?.statusCode
    if (status === undefined) return true // network-level: no response at all
    if (status === 401) return Boolean(getAccessToken)
    if (status === 408 || status === 429) return true
    return status >= 500
  }

  async function authorization () {
    if (!token) token = assertString(await getAccessToken(), 'getAccessToken() result')
    return `Bearer ${token}`
  }

  async function attempt (operation, url, init) {
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: await authorization() }
    })
    if (!response.ok) throw responseError(response, operation)
    return response
  }

  async function request (operation, url, init = {}) {
    requests++
    for (let n = 1; ; n++) {
      try {
        return await attempt(operation, url, init)
      } catch (error) {
        if (n >= MAX_ATTEMPTS || !isRetryable(error)) {
          failures++
          throw error
        }
        // Drop a token Drive has just rejected, so the next attempt asks for a
        // new one instead of replaying the same rejection three more times.
        if (error?.statusCode === 401 && getAccessToken) token = ''
        retries++
        await sleep(backoffMs(n))
      }
    }
  }

  // Every file that carries the name, not the first one Drive felt like
  // listing. `pageSize=1` on an unsorted query was how a key came to be bound
  // to an arbitrary duplicate - and after a re-put patched the other one, to
  // stale bytes. One page of 100 is far more than a block key can legitimately
  // have, and Drive is asked for newest-first so the page that is read is the
  // page that matters.
  async function listByName (key) {
    const q = `name = '${quoteForQuery(key)}' and '${quoteForQuery(folderId)}' in parents and trashed = false`
    const url = `${filesEndpoint}?q=${encodeURIComponent(q)}` +
      `&fields=${encodeURIComponent('files(id,modifiedTime)')}` +
      `&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=100`
    const response = await request('lookup', url)
    const body = await response.json()
    const files = Array.isArray(body?.files) ? body.files : []
    return files.filter(file => typeof file?.id === 'string' && file.id.length > 0)
  }

  // The ordering is decided here rather than trusted from the response, so two
  // relays reading the same folder bind the same key to the same file: newest
  // modification wins, and the id breaks a tie. Drive's timestamps are RFC 3339
  // in UTC, which sorts correctly as text.
  function newest (files) {
    let best = null
    for (const file of files) {
      if (best === null) {
        best = file
        continue
      }
      const mine = String(file.modifiedTime || '')
      const theirs = String(best.modifiedTime || '')
      if (mine > theirs || (mine === theirs && file.id > best.id)) best = file
    }
    return best
  }

  async function lookupId (key) {
    const files = await listByName(key)
    const best = newest(files)
    if (best === null) {
      ids.delete(key)
      duplicates.delete(key)
      return null
    }
    // Remembering that the folder is ambiguous is what lets the next put clean
    // it up even when that put patches in place rather than creating.
    if (files.length > 1) duplicates.add(key)
    ids.set(key, best.id)
    return best.id
  }

  async function resolveId (key) {
    const cached = ids.get(key)
    if (cached) return cached
    return lookupId(key)
  }

  async function deleteFile (id) {
    try {
      await request('delete', `${filesEndpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      if (error.statusCode !== 404) throw error
      failures--
    }
  }

  // Drive's create is not idempotent: `request` retries a POST whose response
  // was lost, and Drive has already committed the first one, so the folder ends
  // up with two files of the same name. They are resolved here, against the id
  // whose stored bytes were just proved, rather than left for a later lookup to
  // pick between. The search index can lag a create, so a duplicate this misses
  // is caught by the next lookup - which is why `newest` has to be right too.
  async function reconcile (key, id) {
    for (const file of await listByName(key)) {
      if (file.id === id) continue
      await deleteFile(file.id)
    }
    duplicates.delete(key)
  }

  // Drive computes `sha256Checksum` for the content it holds, but a create
  // response that happens to omit the field is not evidence that the bytes are
  // right. Asking for it by id costs one request, is answered from the file
  // rather than from the search index, and closes the only path on which this
  // used to report success without having checked anything.
  async function storedChecksum (id) {
    const url = `${filesEndpoint}/${encodeURIComponent(id)}?fields=${encodeURIComponent('sha256Checksum')}`
    const response = await request('verify', url)
    const body = await response.json()
    const digest = body?.sha256Checksum
    return typeof digest === 'string' && digest.length > 0 ? digest : null
  }

  function multipartBody (metadata, bytes) {
    const head = b4a.from(
      `--${MULTIPART_BOUNDARY}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${MULTIPART_BOUNDARY}\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
    )
    const tail = b4a.from(`\r\n--${MULTIPART_BOUNDARY}--`)
    return b4a.concat([head, bytes, tail])
  }

  async function uploadMultipart (key, bytes) {
    const url = `${uploadEndpoint}?uploadType=multipart&fields=${encodeURIComponent('id,sha256Checksum')}`
    const response = await request('put', url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
      body: multipartBody({ name: key, parents: [folderId] }, bytes)
    })
    return response.json()
  }

  // Drive's resumable protocol is two requests: one that registers the upload
  // and answers with a session URL, then the bytes. A block fits in memory by
  // construction — the offloader holds one at a time — so the bytes go in a
  // single PUT rather than in chunks.
  async function uploadResumable (key, bytes) {
    const startUrl = `${uploadEndpoint}?uploadType=resumable&fields=${encodeURIComponent('id,sha256Checksum')}`
    const started = await request('put', startUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(bytes.byteLength)
      },
      body: b4a.from(JSON.stringify({ name: key, parents: [folderId] }))
    })
    const session = started.headers?.get?.('location')
    if (typeof session !== 'string' || session.length === 0) {
      failures++
      const error = new Error('Google Drive put failed: the resumable upload returned no session URL')
      error.statusCode = 502
      throw error
    }
    const response = await request('put', session, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
      },
      body: bytes
    })
    return response.json()
  }

  // Drive creates a second file with the same name rather than replacing one,
  // so re-putting a key has to patch the media of the file already there. The
  // S3 provider gets this for free from PUT, and the offloader relies on it:
  // a retried block must not leave two files behind and an ambiguous lookup.
  async function replaceMedia (id, bytes) {
    const url = `${uploadEndpoint}/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent('id,sha256Checksum')}`
    const response = await request('put', url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    return response.json()
  }

  return {
    getStatus,

    /**
     * `checksumSha256Base64` carries the same wire format the S3 provider
     * documents: the BASE64 of the raw SHA-256 digest. Drive cannot be handed a
     * checksum to enforce on upload, so the digest of what it stored is checked
     * afterwards — always, not only when the upload response happened to carry
     * `sha256Checksum`. A put that could not check is a put that failed: the
     * offloader deletes the local block on success, so failing open here would
     * hand the last good copy of a block to a "probably fine".
     */
    async putBlock ({ key, data, checksumSha256Base64 } = {}) {
      assertString(key, 'key')
      const bytes = asBytes(data)
      // The caller's checksum is the authority when there is one — it is what
      // the merkle tree upstream committed to — and the digest of the bytes
      // handed over stands in when there is not.
      const expected = typeof checksumSha256Base64 === 'string' && checksumSha256Base64.length > 0
        ? checksumSha256Base64
        : sha256Base64(bytes)
      // The lookup before the upload is what a cold key costs: Drive has no
      // conditional create, and creating blind would leave a second file with
      // the same name behind every retried block. It is paid once — after this
      // the id is cached and a re-put patches in place.
      const existing = await resolveId(key)
      const result = existing
        ? await replaceMedia(existing, bytes)
        : bytes.byteLength > MULTIPART_LIMIT
          ? await uploadResumable(key, bytes)
          : await uploadMultipart(key, bytes)
      const id = result?.id
      if (typeof id !== 'string' || id.length === 0) {
        failures++
        const error = new Error('Google Drive put failed: the upload returned no file id')
        error.statusCode = 502
        throw error
      }
      const stored = typeof result.sha256Checksum === 'string' && result.sha256Checksum.length > 0
        ? result.sha256Checksum
        : await storedChecksum(id)
      // A file this put created and could not prove must not survive it: left
      // behind it is the newest file with that name, so the next lookup would
      // bind the key straight to the bytes that just failed. A file that was
      // already there is never removed on a failed put — it may be the only
      // copy of the block left anywhere.
      const reject = async (message, statusCode) => {
        if (!existing) {
          try {
            await deleteFile(id)
          } catch (error) {
            // `request` has already counted this one, so the put is a failure
            // either way and the reason names both halves of it.
            const failed = new Error(`${message}, and the unproved file ${id} could not be removed: ${error.message}`)
            failed.statusCode = error.statusCode ?? 502
            throw failed
          }
        }
        // Counted after the removal, because removing a file that was already
        // gone un-counts a failure of its own and must not cancel this one.
        failures++
        const error = new Error(message)
        error.statusCode = statusCode
        throw error
      }
      if (stored === null) {
        await reject(`Google Drive put failed: ${key} landed with no SHA-256 Drive would report, so the stored bytes cannot be proved`, 502)
      }
      if (hexToBase64(stored) !== expected) {
        await reject(`Google Drive put failed: ${key} landed with a different SHA-256 than it was sent with`, 422)
      }
      ids.set(key, id)
      // A create may have been retried over a committed POST, and a lookup may
      // have seen a folder that was already ambiguous. Either way the duplicates
      // die here, against the one id whose bytes are now proved.
      if (!existing || duplicates.has(key)) await reconcile(key, id)
      return { success: true, key }
    },

    /**
     * Drive honours a byte `Range` on an `alt=media` download, which is what
     * restore-on-read needs: one block out of a larger object, without pulling
     * the whole object back to the relay.
     */
    async getBlock ({ key, range } = {}) {
      assertString(key, 'key')
      const id = await resolveId(key)
      if (!id) throw absentError(key, 'get')
      const headers = range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}
      const url = `${filesEndpoint}/${encodeURIComponent(id)}?alt=media`
      try {
        const response = await request('get', url, { headers })
        return response.arrayBuffer()
      } catch (error) {
        // A cached id Drive no longer knows means the file moved or was
        // deleted behind our back; forget it so the next read looks it up.
        if (error.statusCode === 404) ids.delete(key)
        throw error
      }
    },

    /**
     * A block that is not there is a normal answer, not a provider fault, so it
     * leaves `getStatus().healthy` true. The S3 provider had exactly this bug —
     * every absent block marked the whole tier unhealthy — and it is not being
     * reintroduced here.
     */
    async hasBlock ({ key } = {}) {
      assertString(key, 'key')
      const cached = ids.get(key)
      if (!cached) return Boolean(await lookupId(key))
      try {
        await request('has', `${filesEndpoint}/${encodeURIComponent(cached)}?fields=id`)
        return true
      } catch (error) {
        if (error.statusCode === 404) {
          failures--
          ids.delete(key)
          return false
        }
        throw error
      }
    },

    /**
     * Deleting a key that is already gone succeeds, matching S3's DELETE. The
     * offloader retries a delete after a crash, and a second attempt must not
     * be reported as a failure.
     *
     * Every file carrying the name goes, not only the one the cache points at: a
     * duplicate left behind makes a deleted key reappear on the next lookup,
     * bound to bytes nothing has verified. The cached id is deleted first
     * because it is answered from the file itself, while Drive's name search can
     * still be listing a file it has already removed - or not yet listing one it
     * has just created.
     */
    async deleteBlock ({ key } = {}) {
      assertString(key, 'key')
      const cached = ids.get(key)
      if (cached) await deleteFile(cached)
      for (const file of await listByName(key)) {
        if (file.id === cached) continue
        await deleteFile(file.id)
      }
      ids.delete(key)
      duplicates.delete(key)
      return { success: true, key }
    }
  }
}
