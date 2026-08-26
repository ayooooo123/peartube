import b4a from 'b4a'

export const PROTOCOL_MAJOR = 2
export const PROTOCOL_MINOR = 0

export const MAX_PROTOCOL_CAPABILITIES = 32
export const MAX_PROTOCOL_CAPABILITY_BYTES = 64
export const MAX_PROTOCOL_CAPABILITIES_BYTES = 2_048

export const PROTOCOL_ERROR_CODES = Object.freeze({
  ADVERTISEMENT_REQUIRED: 'PROTOCOL_ADVERTISEMENT_REQUIRED',
  MAJOR_UNSUPPORTED: 'PROTOCOL_MAJOR_UNSUPPORTED',
  CAPABILITY_UNSUPPORTED: 'PROTOCOL_CAPABILITY_UNSUPPORTED',
})

const CAPABILITY_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/
const COMPATIBILITY_FIELDS = Object.freeze([
  'minimumProtocolMajor',
  'protocolMinor',
  'requiredCapabilities',
])

export class ProtocolCompatibilityError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ProtocolCompatibilityError'
    this.code = code
    Object.assign(this, details)
  }
}

function compatibilityError(code, message, details) {
  throw new ProtocolCompatibilityError(code, message, details)
}

function normalizeVersion(value, name, fallback) {
  const minimum = name === 'minimumProtocolMajor' ? 1 : 0
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 255) {
    throw new Error(`${name} must be an integer between ${minimum} and 255`)
  }
  return value
}

export function normalizeRequiredCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities)) throw new Error('requiredCapabilities must be an array')
  if (capabilities.length > MAX_PROTOCOL_CAPABILITIES) throw new Error('requiredCapabilities count exceeds its limit')
  let totalBytes = 0
  const normalized = capabilities.map(capability => {
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
      throw new Error('required capability identifier is invalid')
    }
    const bytes = b4a.byteLength(capability)
    if (bytes > MAX_PROTOCOL_CAPABILITY_BYTES) throw new Error('required capability identifier exceeds its byte limit')
    totalBytes += bytes
    if (totalBytes > MAX_PROTOCOL_CAPABILITIES_BYTES) throw new Error('required capability identifiers exceed their total byte limit')
    return capability
  })
  return Array.from(new Set(normalized)).sort()
}

export function createProtocolAdvertisement(input = {}, defaults = {}) {
  const requiredCapabilities = normalizeRequiredCapabilities([
    ...(defaults.requiredCapabilities || []),
    ...(input.requiredCapabilities || []),
  ])
  return {
    minimumProtocolMajor: normalizeVersion(input.minimumProtocolMajor, 'minimumProtocolMajor', PROTOCOL_MAJOR),
    protocolMinor: normalizeVersion(input.protocolMinor, 'protocolMinor', PROTOCOL_MINOR),
    requiredCapabilities,
  }
}

function hasCompleteAdvertisement(value) {
  return COMPATIBILITY_FIELDS.every(field => Object.hasOwn(value, field))
}

function normalizeAdvertisement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    compatibilityError(PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED, 'protocol compatibility advertisement is required')
  }
  return createProtocolAdvertisement(value)
}

function assertCanonicalCapabilities(advertised, normalized) {
  if (!Array.isArray(advertised) || advertised.length !== normalized.length) {
    throw new Error('requiredCapabilities must be sorted and unique')
  }
  for (let index = 0; index < normalized.length; index++) {
    if (advertised[index] !== normalized[index]) throw new Error('requiredCapabilities must be sorted and unique')
  }
}

export function assertProtocolCompatibility(value = {}, options = {}) {
  const present = COMPATIBILITY_FIELDS.filter(field => Object.hasOwn(value, field))
  let source = value
  if (!hasCompleteAdvertisement(value)) {
    if (present.length !== 0 || !options.legacyCompatibility) {
      compatibilityError(
        PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED,
        'complete protocol compatibility advertisement is required'
      )
    }
    source = options.legacyCompatibility
    if (!hasCompleteAdvertisement(source)) {
      compatibilityError(
        PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED,
        'explicit legacy compatibility declaration is incomplete'
      )
    }
  }

  let advertisement
  try {
    advertisement = normalizeAdvertisement(source)
    assertCanonicalCapabilities(source.requiredCapabilities, advertisement.requiredCapabilities)
  } catch (error) {
    if (error instanceof ProtocolCompatibilityError) throw error
    compatibilityError(
      PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED,
      'protocol compatibility advertisement is malformed'
    )
  }
  const localMajor = normalizeVersion(options.protocolMajor, 'minimumProtocolMajor', PROTOCOL_MAJOR)
  if (advertisement.minimumProtocolMajor !== localMajor) {
    compatibilityError(
      PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED,
      `protocol major ${advertisement.minimumProtocolMajor} is not supported`,
      { minimumProtocolMajor: advertisement.minimumProtocolMajor, supportedProtocolMajor: localMajor }
    )
  }

  const mandatory = normalizeRequiredCapabilities(options.mandatoryCapabilities || [])
  for (const capability of mandatory) {
    if (!advertisement.requiredCapabilities.includes(capability)) {
      compatibilityError(
        PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED,
        `protocol compatibility advertisement is missing mandatory capability ${capability}`,
        { capability }
      )
    }
  }

  const supported = new Set(normalizeRequiredCapabilities(options.supportedCapabilities || []))
  for (const capability of advertisement.requiredCapabilities) {
    if (!supported.has(capability)) {
      compatibilityError(
        PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        `required protocol capability ${capability} is not supported`,
        { capability }
      )
    }
  }
  return advertisement
}
