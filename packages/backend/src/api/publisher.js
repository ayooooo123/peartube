import b4a from 'b4a'

import { createPublisherKeyProvider } from '../publisher/key-provider.js'

function normalizeAllowedSigners(request = {}) {
  if (Array.isArray(request.allowedSigners) && request.allowedSigners.length > 0) return request.allowedSigners
  if (request.signer) return [request.signer]
  return []
}

function parseDisplaySummaryJson(value) {
  if (!value) return null
  if (typeof value !== 'string') throw new Error('displaySummaryJson must be a string')
  return JSON.parse(value)
}

function stringifyDisplaySummary(value) {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function toBuffer(value) {
  return b4a.isBuffer(value) || value instanceof Uint8Array ? b4a.from(value) : b4a.alloc(0)
}

export function createPublisherApi(options = {}) {
  const provider = createPublisherKeyProvider({ now: options.now || (() => Date.now()) })

  return {
    async preparePublisherRootOperation(request = {}) {
      try {
        const prepared = provider.preparePublisherRootOperation({
          publisherId: request.publisherId,
          recordType: request.recordType,
          body: toBuffer(request.body),
          displaySummary: parseDisplaySummaryJson(request.displaySummaryJson),
          issuedAt: request.issuedAt,
          expiresAt: request.expiresAt,
          expiresInMs: request.expiresInMs,
        })
        return {
          success: true,
          publisherId: prepared.publisherId,
          recordType: prepared.recordType,
          unsignedBytes: prepared.unsignedBytes,
          candidateRecordId: prepared.candidateRecordId,
          bodyLength: prepared.bodyLength,
          issuedAt: prepared.issuedAt,
          expiresAt: prepared.expiresAt,
          displaySummaryJson: stringifyDisplaySummary(prepared.displaySummary),
          error: null,
        }
      } catch (error) {
        return {
          success: false,
          publisherId: request.publisherId || null,
          recordType: request.recordType || null,
          unsignedBytes: b4a.alloc(0),
          candidateRecordId: b4a.alloc(0),
          bodyLength: 0,
          issuedAt: 0,
          expiresAt: 0,
          displaySummaryJson: null,
          error: error?.message || 'prepare failed',
        }
      }
    },

    async submitPublisherRootOperation(request = {}) {
      try {
        const result = await provider.submitPublisherRootOperation({
          prepared: {
            publisherId: request.publisherId,
            recordType: request.recordType,
            unsignedBytes: toBuffer(request.unsignedBytes),
            candidateRecordId: toBuffer(request.candidateRecordId),
            displaySummary: parseDisplaySummaryJson(request.displaySummaryJson),
          },
          signer: toBuffer(request.signer),
          signature: toBuffer(request.signature),
          allowedSigners: normalizeAllowedSigners(request),
        })
        if (!result.valid) {
          return {
            success: false,
            valid: false,
            reason: result.reason || 'signature-verification-failed',
            publisherId: request.publisherId || null,
            recordType: request.recordType || null,
            recordId: b4a.alloc(0),
            signer: b4a.alloc(0),
            signature: b4a.alloc(0),
          }
        }
        return {
          success: true,
          valid: true,
          reason: null,
          publisherId: result.publisherId,
          recordType: result.recordType,
          recordId: result.recordId,
          signer: result.signer,
          signature: result.envelope.signature,
        }
      } catch (error) {
        return {
          success: false,
          valid: false,
          reason: error?.message || 'submit failed',
          publisherId: request.publisherId || null,
          recordType: request.recordType || null,
          recordId: b4a.alloc(0),
          signer: b4a.alloc(0),
          signature: b4a.alloc(0),
        }
      }
    },
  }
}
