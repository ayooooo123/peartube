import c from 'compact-encoding'
import b4a from 'b4a'

const KEY_BYTES = 32

function fixed32(value, fieldName) {
  if (!value) throw new TypeError(`${fieldName} is required`)

  const buffer = b4a.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? b4a.from(value, 'hex')
      : b4a.from(value)

  if (buffer.byteLength !== KEY_BYTES) {
    throw new RangeError(`${fieldName} must be exactly ${KEY_BYTES} bytes`)
  }

  return buffer
}

function uint(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a safe unsigned integer`)
  }
  return value
}

function normalizeVariant(variant, index) {
  if (!variant || typeof variant !== 'object') {
    throw new TypeError(`variants[${index}] must be an object`)
  }

  if (typeof variant.resolution !== 'string' || variant.resolution.length === 0) {
    throw new TypeError(`variants[${index}].resolution must be a non-empty string`)
  }

  const startBlock = uint(variant.startBlock, `variants[${index}].startBlock`)
  const endBlock = uint(variant.endBlock, `variants[${index}].endBlock`)

  if (endBlock < startBlock) {
    throw new RangeError(`variants[${index}].endBlock must be >= startBlock`)
  }

  return {
    resolution: variant.resolution,
    coreKey: fixed32(variant.coreKey, `variants[${index}].coreKey`),
    startBlock,
    endBlock,
  }
}

export function normalize(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw new TypeError('mapping must be an object')
  }

  if (typeof mapping.sourceId !== 'string' || mapping.sourceId.length === 0) {
    throw new TypeError('sourceId must be a non-empty string')
  }

  if (!Array.isArray(mapping.variants)) {
    throw new TypeError('variants must be an array')
  }

  const variants = mapping.variants.map(normalizeVariant)
  const hypercoreKey = fixed32(mapping.hypercoreKey ?? mapping.coreKey ?? variants[0]?.coreKey, 'hypercoreKey')
  for (const variant of variants) {
    if (!b4a.equals(variant.coreKey, hypercoreKey)) {
      throw new Error('variants must reference the canonical hypercoreKey')
    }
  }

  return {
    fileHash: fixed32(mapping.fileHash, 'fileHash'),
    hypercoreKey,
    sourceId: mapping.sourceId,
    variants,
  }
}

const variantCodec = {
  preencode(state, variant) {
    c.string.preencode(state, variant.resolution)
    c.fixed32.preencode(state, variant.coreKey)
    c.uint.preencode(state, variant.startBlock)
    c.uint.preencode(state, variant.endBlock)
  },
  encode(state, variant) {
    c.string.encode(state, variant.resolution)
    c.fixed32.encode(state, variant.coreKey)
    c.uint.encode(state, variant.startBlock)
    c.uint.encode(state, variant.endBlock)
  },
  decode(state) {
    return {
      resolution: c.string.decode(state),
      coreKey: c.fixed32.decode(state),
      startBlock: c.uint.decode(state),
      endBlock: c.uint.decode(state),
    }
  },
}

export const fileMappingCodec = {
  preencode(state, mapping) {
    c.fixed32.preencode(state, mapping.fileHash)
    c.string.preencode(state, mapping.sourceId)
    c.array(variantCodec).preencode(state, mapping.variants)
  },
  encode(state, mapping) {
    c.fixed32.encode(state, mapping.fileHash)
    c.string.encode(state, mapping.sourceId)
    c.array(variantCodec).encode(state, mapping.variants)
  },
  decode(state) {
    const fileHash = c.fixed32.decode(state)
    const sourceId = c.string.decode(state)
    const variants = c.array(variantCodec).decode(state)
    return {
      fileHash,
      hypercoreKey: variants[0]?.coreKey,
      sourceId,
      variants,
    }
  },
}

const legacyFileMappingCodec = {
  preencode(state, mapping) {
    c.fixed32.preencode(state, mapping.fileHash)
    c.string.preencode(state, mapping.sourceId)
    c.array(variantCodec).preencode(state, mapping.variants)
  },
  encode(state, mapping) {
    c.fixed32.encode(state, mapping.fileHash)
    c.string.encode(state, mapping.sourceId)
    c.array(variantCodec).encode(state, mapping.variants)
  },
  decode(state) {
    const fileHash = c.fixed32.decode(state)
    const sourceId = c.string.decode(state)
    const variants = c.array(variantCodec).decode(state)
    return {
      fileHash,
      hypercoreKey: variants[0]?.coreKey,
      sourceId,
      variants,
    }
  },
}

export function encode(mapping) {
  const canonical = normalize(mapping)
  const state = c.state()

  fileMappingCodec.preencode(state, canonical)
  state.buffer = b4a.allocUnsafe(state.end)
  fileMappingCodec.encode(state, canonical)

  return state.buffer
}

export function encodeLegacyForTest(mapping) {
  const canonical = normalize(mapping)
  const state = c.state()

  legacyFileMappingCodec.preencode(state, canonical)
  state.buffer = b4a.allocUnsafe(state.end)
  legacyFileMappingCodec.encode(state, canonical)

  return state.buffer
}

export function decode(buf) {
  const buffer = b4a.isBuffer(buf) ? buf : b4a.from(buf)
  let state = c.state(0, buffer.byteLength, buffer)
  let mapping

  try {
    mapping = fileMappingCodec.decode(state)
    if (state.start !== state.end) throw new Error('archive mapping buffer has trailing bytes')
  } catch (error) {
    state = c.state(0, buffer.byteLength, buffer)
    try {
      mapping = legacyFileMappingCodec.decode(state)
    } catch {
      throw error
    }
  }

  if (state.start !== state.end) {
    throw new Error('archive mapping buffer has trailing bytes')
  }

  return normalize(mapping)
}
