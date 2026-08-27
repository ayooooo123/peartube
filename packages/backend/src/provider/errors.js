export const PROVIDER_ERROR_CODES = Object.freeze({
  INVALID_FIELD: 'INVALID_FIELD',
  INVALID_CURSOR: 'INVALID_CURSOR',
  CURSOR_EXPIRED: 'CURSOR_EXPIRED',
  RESOLUTION_NOT_FOUND: 'RESOLUTION_NOT_FOUND',
  RESOLUTION_EXPIRED: 'RESOLUTION_EXPIRED',
  MODERATION_BLOCKED: 'MODERATION_BLOCKED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  ACQUISITION_REQUIRED: 'ACQUISITION_REQUIRED',
  ACQUISITION_FORBIDDEN: 'ACQUISITION_FORBIDDEN',
  ACQUISITION_UNAVAILABLE: 'ACQUISITION_UNAVAILABLE',
  ACQUISITION_NOT_COMPLETED: 'ACQUISITION_NOT_COMPLETED',
  PUBLICATION_NOT_FOUND: 'PUBLICATION_NOT_FOUND',
  PUBLICATION_NOT_VERIFIED: 'PUBLICATION_NOT_VERIFIED',
  STREAM_UNAVAILABLE: 'STREAM_UNAVAILABLE',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  STATUS_UNAVAILABLE: 'STATUS_UNAVAILABLE',
  PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
})

export class ProviderError extends Error {
  constructor(code, message, { field = null, retryable = false } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.field = field
    this.retryable = retryable
  }
}

export function providerError(code, message, options) {
  return new ProviderError(code, message, options)
}

export function mapProviderError(error, code, message, options) {
  if (error instanceof ProviderError) return error
  return providerError(code, message, options)
}
