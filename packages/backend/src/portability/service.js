import b4a from 'b4a'

import { isPlainObject, encodeCanonicalPortableJson } from './canonical.js'
import {
  PORTABLE_STATE_ERROR_CODES,
  PORTABLE_STATE_VERSION
} from './constants.js'
import { PortableStateError, portableStateErrorResult } from './errors.js'
import {
  countPortableStateItems,
  createPortableStateManifest,
  decodePortableStateManifest,
  digestPortableManifestBytes
} from './manifest.js'

function invalidRequest (message) {
  throw new PortableStateError(PORTABLE_STATE_ERROR_CODES.INVALID_REQUEST, message)
}

function validateExportRequest (request) {
  if (!isPlainObject(request)) invalidRequest('exportPortableState request must be an object')
  const fields = Object.keys(request)
  if (fields.length !== 0) invalidRequest(`exportPortableState request has unknown field ${fields[0]}`)
}

function validateRestoreRequest (request) {
  if (!isPlainObject(request)) invalidRequest('restorePortableState request must be an object')
  for (const key of Object.keys(request)) {
    if (key !== 'manifestBytes' && key !== 'manifestDigest') invalidRequest(`restorePortableState request has unknown field ${key}`)
  }
  if (!Object.hasOwn(request, 'manifestBytes')) invalidRequest('restorePortableState request requires manifestBytes')
  if (!(b4a.isBuffer(request.manifestBytes) || request.manifestBytes instanceof Uint8Array)) invalidRequest('manifestBytes must be bytes')
}

function normalizeTransactionResult (value, itemCount) {
  if (!isPlainObject(value)) throw new Error('restore transaction must return a result object')
  const fields = Object.keys(value)
  for (const field of fields) {
    if (field !== 'importedCount' && field !== 'skippedCount' && field !== 'idempotent') {
      throw new Error(`restore transaction result has unknown field ${field}`)
    }
  }
  const importedCount = value.importedCount
  const skippedCount = value.skippedCount
  if (!Number.isSafeInteger(importedCount) || importedCount < 0 || !Number.isSafeInteger(skippedCount) || skippedCount < 0) {
    throw new Error('restore transaction counts must be nonnegative safe integers')
  }
  if (importedCount + skippedCount !== itemCount) throw new Error('restore transaction counts do not cover the manifest item count')
  if (typeof value.idempotent !== 'boolean') throw new Error('restore transaction idempotent must be boolean')
  if (value.idempotent && importedCount !== 0) throw new Error('idempotent restore transaction must not import items')
  return { importedCount, skippedCount, idempotent: value.idempotent }
}

export function createPortableStateService (options = {}) {
  const snapshotPortableState = options.snapshotPortableState
  const restoreTransaction = options.restoreTransaction
  const verifyArchiveEvidence = options.verifyArchiveEvidence
  const now = options.now || (() => Date.now())
  if (typeof snapshotPortableState !== 'function') throw new TypeError('createPortableStateService requires snapshotPortableState')
  if (typeof restoreTransaction !== 'function') throw new TypeError('createPortableStateService requires restoreTransaction')
  if (typeof now !== 'function') throw new TypeError('createPortableStateService now must be a function')

  return Object.freeze({
    async exportPortableState (request = {}) {
      try {
        validateExportRequest(request)
        const rawState = await snapshotPortableState()
        const manifest = await createPortableStateManifest(rawState, {
          createdAt: now(),
          verifyArchiveEvidence
        })
        const manifestBytes = encodeCanonicalPortableJson(manifest)
        const manifestDigest = digestPortableManifestBytes(manifestBytes)
        return {
          success: true,
          schemaVersion: PORTABLE_STATE_VERSION,
          manifestBytes,
          manifestDigest,
          itemCount: countPortableStateItems(manifest.state)
        }
      } catch (error) {
        return portableStateErrorResult(error, PORTABLE_STATE_ERROR_CODES.EXPORT_FAILED)
      }
    },

    async restorePortableState (request = {}) {
      try {
        validateRestoreRequest(request)
        const decoded = await decodePortableStateManifest(request.manifestBytes, {
          expectedDigest: request.manifestDigest,
          verifyArchiveEvidence
        })
        let normalized
        try {
          const transactionResult = await restoreTransaction({
            manifestDigest: decoded.manifestDigest,
            schemaVersion: PORTABLE_STATE_VERSION,
            state: decoded.manifest.state,
            itemCount: decoded.itemCount
          })
          normalized = normalizeTransactionResult(transactionResult, decoded.itemCount)
        } catch (error) {
          throw new PortableStateError(PORTABLE_STATE_ERROR_CODES.TRANSACTION_FAILED, `portable-state restore transaction failed: ${error?.message || String(error)}`)
        }
        return {
          success: true,
          schemaVersion: PORTABLE_STATE_VERSION,
          ...normalized
        }
      } catch (error) {
        return portableStateErrorResult(error, PORTABLE_STATE_ERROR_CODES.INVALID_FIELD)
      }
    }
  })
}
