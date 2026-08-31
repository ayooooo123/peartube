import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import {
  WRITER_CAPABILITIES,
  createPublisherNamespaceDescriptor,
  decodePublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody
} from '@peartube/backend/publisher'
import { decodeUnsignedSignedEnvelope, signedRecordSignaturePreimage } from '@peartube/backend/records'

// Uploading requires a writable, admitted publisher catalog. On a phone the
// publisher root lives in the device keychain and the user confirms each root
// operation; a relay has neither, so it owns the root itself and authorizes its
// own namespace and writer-admission records. This is the headless equivalent
// of packages/app/lib/publisher-shell-service.ts.

const INTENT_TTL_MS = 2 * 60_000
// The relay's writer admission is long-lived: nothing is present to re-confirm
// it, and an expired admission silently stops the relay from publishing.
const WRITER_EXPIRY = 4102444800000 // 2100-01-01
const ROOT_FILE = 'publisher-root'

// bare-fs can hand back a Buffer even when an encoding is requested, and a
// Buffer here would fail to parse and silently mint fresh custody material.
function text (value) {
  return typeof value === 'string' ? value : b4a.toString(value, 'utf8')
}

function hex (value) {
  return b4a.toString(b4a.from(value), 'hex')
}

function equalBytes (left, right) {
  if (!left || !right) return false
  return b4a.equals(b4a.from(left), b4a.from(right))
}

export function createRelayPublisherShell ({ api, storagePath, fs, logger = null, now = () => Date.now() }) {
  if (!api) throw new Error('api is required')
  if (!storagePath) throw new Error('storagePath is required')

  let ready = null

  async function fsModule () {
    return fs || await import('#fs')
  }

  // The publisher root is a separate keypair from the relay's identity: the
  // catalog is addressed by derivePublisherId(rootPublicKey), so losing this
  // file means losing the catalog rather than just a device.
  //
  // hypercore-storage sweeps unrecognized root entries into db/ when it opens,
  // so a root written during one run is found under db/ on the next. db/ is
  // read first because that is where the surviving original ends up.
  async function getOrCreateRoot () {
    const mod = await fsModule()
    const rootPath = `${storagePath}/${ROOT_FILE}`
    for (const candidate of [`${storagePath}/db/${ROOT_FILE}`, rootPath]) {
      try {
        const parsed = JSON.parse(text(mod.readFileSync(candidate, 'utf8')))
        const publicKey = b4a.from(parsed.publicKey, 'hex')
        const secretKey = b4a.from(parsed.secretKey, 'hex')
        if (publicKey.byteLength !== 32 || secretKey.byteLength !== 64) continue
        // A corrupt pairing would produce signatures the backend rejects with
        // no indication of why, so prove the keys still belong together.
        const challenge = crypto.randomBytes(32)
        if (crypto.verify(challenge, crypto.sign(challenge, secretKey), publicKey) !== true) {
          throw new Error('publisher root key mismatch')
        }
        return { publicKey, secretKey }
      } catch (err) {
        if (err?.message === 'publisher root key mismatch') throw err
        // Missing or unreadable here; try the next location, then create one.
      }
    }
    const keyPair = crypto.keyPair()
    mod.writeFileSync(
      rootPath,
      `${JSON.stringify({ publicKey: hex(keyPair.publicKey), secretKey: hex(keyPair.secretKey) })}\n`,
      { mode: 0o600 }
    )
    return { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey }
  }

  // The relay signs its own root operations, so the usual human confirmation
  // step is gone. The prepared record is still checked field by field against
  // the intent: a backend that prepared a different record than the one built
  // here must not get the root key's signature on it.
  async function authorizeRootOperation ({ root, publisherId, recordType, body, summary }) {
    const issuedAt = now()
    const intentExpiresAt = issuedAt + INTENT_TTL_MS
    const intentId = hex(crypto.randomBytes(16))
    const displaySummaryJson = JSON.stringify(summary)

    const prepared = await api.preparePublisherRootOperation({
      publisherId,
      recordType,
      body,
      displaySummaryJson,
      issuedAt,
      expiresInMs: INTENT_TTL_MS,
      intentExpiresAt,
      intentId,
      signerPublicKey: root.publicKey
    })

    if (prepared?.success !== true ||
        prepared.intentId !== intentId ||
        prepared.publisherId !== publisherId ||
        prepared.recordType !== recordType ||
        prepared.displaySummaryJson !== displaySummaryJson ||
        Number(prepared.intentExpiresAt) !== intentExpiresAt ||
        !equalBytes(prepared.signerPublicKey, root.publicKey)) {
      throw new Error(`publisher root prepare mismatch for ${recordType}`)
    }

    const unsignedBytes = b4a.from(prepared.unsignedBytes)
    const candidateRecordId = b4a.from(prepared.candidateRecordId)
    if (!equalBytes(crypto.hash(unsignedBytes), candidateRecordId)) {
      throw new Error(`publisher root record id mismatch for ${recordType}`)
    }

    // Matching the hash only proves the record id describes these bytes. Decode
    // them and confirm they still carry the body built above, so a backend that
    // prepared some other namespace or admission cannot borrow the root
    // signature for it.
    const decoded = decodeUnsignedSignedEnvelope(unsignedBytes)
    if (!equalBytes(decoded.canonicalBody, body) ||
        decoded.bodyLength !== prepared.bodyLength ||
        decoded.signedAt !== issuedAt ||
        !equalBytes(decoded.signerKey, root.publicKey)) {
      throw new Error(`publisher root body mismatch for ${recordType}`)
    }

    const signature = crypto.sign(signedRecordSignaturePreimage({ recordType, recordId: candidateRecordId }), root.secretKey)
    const submitted = await api.submitPublisherRootOperation({
      intentId,
      publisherId,
      recordType,
      unsignedBytes,
      candidateRecordId,
      displaySummaryJson,
      signer: root.publicKey,
      signerPublicKey: root.publicKey,
      signature
    })

    if (submitted?.success !== true || submitted.complete !== true ||
        submitted.intentId !== intentId || submitted.publisherId !== publisherId ||
        submitted.recordType !== recordType ||
        !equalBytes(submitted.recordId, candidateRecordId)) {
      throw new Error(`publisher root submit failed for ${recordType}: ${JSON.stringify(submitted, (k,v) => (v && v.type === 'Buffer') ? '<bytes>' : v)}`)
    }
  }

  async function provision (publisherId, genesisRootKey) {
    const response = await api.provisionPublisherCatalog({ publisherId, genesisRootKey })
    if (response?.success === false) {
      throw new Error(`publisher catalog provisioning failed: ${response?.error || response?.reason || response?.errorCode || JSON.stringify(response)}`)
    }
    return response
  }

  async function ensureLocalPublisher () {
    logger?.relay?.info?.('ensureLocalPublisher step 1: getOrCreateRoot')
    const root = await getOrCreateRoot()
    const publisherId = hex(derivePublisherId(root.publicKey))
    logger?.relay?.info?.('ensureLocalPublisher step 2: provision', { publisherId })
    let catalog = await provision(publisherId, root.publicKey)
    logger?.relay?.info?.('ensureLocalPublisher step 3: provision result', {
      namespaceInitialized: catalog.namespaceInitialized,
      admitted: catalog.admitted,
      writable: catalog.writable
    })

    if (!catalog.namespaceInitialized) {
      logger?.relay?.info?.('ensureLocalPublisher step 4: authorize namespace')
      const body = encodePublisherNamespaceDescriptor(createPublisherNamespaceDescriptor({
        genesisRootKey: root.publicKey,
        catalogBootstrapKey: catalog.catalogBootstrapKey
      }))
      const descriptor = decodePublisherNamespaceDescriptor(body)
      await authorizeRootOperation({
        root,
        publisherId,
        recordType: 'publisher.namespace',
        body,
        summary: {
          action: 'create-publisher-namespace',
          publisherId,
          catalogBootstrapKey: hex(descriptor.catalogBootstrapKey)
        }
      })
      catalog = await provision(publisherId, root.publicKey)
      if (!catalog.namespaceInitialized) throw new Error('publisher namespace did not initialize')
      logger?.archive?.info?.('Relay publisher namespace created', { publisherId })
    }

    if (!catalog.admitted) {
      logger?.relay?.info?.('ensureLocalPublisher step 5: authorize admission')
      const body = encodePublisherOperationBody('publisher.writer-admission', {
        writerKey: catalog.localWriterKey,
        signerKey: catalog.localSignerKey,
        capabilities: [...WRITER_CAPABILITIES],
        firstAcceptedSequence: 1,
        expiresAt: WRITER_EXPIRY,
        admissionNonce: crypto.randomBytes(16)
      })
      const admission = decodePublisherOperationBody('publisher.writer-admission', body)
      await authorizeRootOperation({
        root,
        publisherId,
        recordType: 'publisher.writer-admission',
        body,
        summary: {
          action: 'admit-local-publisher-device',
          publisherId,
          writerKey: hex(admission.writerKey),
          signerKey: hex(admission.signerKey),
          capabilities: [...admission.capabilities],
          expiresAt: admission.expiresAt
        }
      })
      catalog = await provision(publisherId, root.publicKey)
      logger?.archive?.info?.('Relay publisher device admitted', { publisherId })
    }

    if (!catalog.writable || !catalog.admitted) throw new Error('relay publisher catalog is not writable and admitted')
    return { publisherId, catalogBootstrapKey: catalog.catalogBootstrapKey }
  }

  return {
    // Provisioning is idempotent but not cheap, and several archive jobs can
    // start at once; collapse them onto one in-flight run.
    ensureLocalPublisher () {
      if (ready) return ready
      ready = ensureLocalPublisher().catch((err) => {
        ready = null
        throw err
      })
      return ready
    }
  }
}
