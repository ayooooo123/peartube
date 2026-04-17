/**
 * Swift codegen for Hyperschema types — wire-compatible with the JS compact-encoding output.
 *
 * Usage:
 *   const { generateWireCompatibleSwiftSchema } = require('./lib/swift-codegen.cjs')
 *   const swift = generateWireCompatibleSwiftSchema('./spec/schema')
 *   // swift is a string containing the complete Schema.swift source
 *
 * Encoding rules (matching JS hyperschema output):
 *   1. Fields are walked in declaration order.
 *   2. Required non-bool, non-array-of-struct fields: encoded unconditionally.
 *   3. Bool fields (required OR optional): contribute a flag bit; not separately encoded.
 *   4. Optional non-bool fields: contribute a flag bit; encoded conditionally.
 *   5. The flags uint (varint) is inserted at `flagsPosition` in the field order.
 *   6. Nested struct references are wrapped in a frame (uint32 length prefix).
 *   7. Arrays of structs use array(frame(innerCodec)); arrays of primitives use array(codec).
 */

const Hyperschema = require('hyperschema')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** kebab-case -> PascalCase */
function pascalCase (name) {
  return name
    .replace(/@[^/]+\//, '') // strip namespace prefix
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

/** kebab-case -> camelCase */
function camelCase (name) {
  const p = pascalCase(name)
  return p.charAt(0).toLowerCase() + p.slice(1)
}

/** Is the type a struct reference (starts with @)? */
function isStructType (typeName) {
  return typeName.startsWith('@')
}

/** Primitive type name -> Swift type */
function swiftPrimitiveType (typeName) {
  switch (typeName) {
    case 'uint': return 'UInt'
    case 'int': return 'Int'
    case 'string': return 'String'
    case 'bool': return 'Bool'
    case 'buffer': return 'Data'
    case 'float32': return 'Float'
    case 'float64': return 'Double'
    default: return null
  }
}

/** Primitive type name -> compact-encoding-swift codec expression */
function primitiveCodecExpr (typeName) {
  switch (typeName) {
    case 'uint': return 'Primitive.UInt()'
    case 'int': return 'Primitive.Int()'
    case 'string': return 'Primitive.UTF8()'
    case 'bool': return 'Primitive.Bool()'
    case 'buffer': return 'Primitive.Buffer()'
    case 'float32': return 'Primitive.Float32()'
    case 'float64': return 'Primitive.Float64()'
    default: return null
  }
}

/** Default value for a decoded optional field when the flag bit is not set */
function defaultValue (field) {
  if (field.type === 'bool') return 'false'
  // All non-bool optional fields are Swift Optionals — use nil
  return 'nil'
}

/** Swift type for a field (including optionality) */
function swiftFieldType (field) {
  let baseType
  if (isStructType(field.type)) {
    baseType = pascalCase(field.type)
  } else {
    baseType = swiftPrimitiveType(field.type)
  }

  if (field.array) {
    baseType = '[' + baseType + ']'
  }

  // Optional: bools that are optional are represented as Bool (flag bit IS the value).
  // Non-bool optionals and optional arrays are Optional.
  // Required bools are also Bool (flag bit IS the value for required bools too).
  if (field.type === 'bool') {
    return 'Bool'
  }

  if (!field.required) {
    // Optional non-bool: use Optional type
    // For uint/int, we still use Optional to match JS null semantics
    return baseType + '?'
  }

  return baseType
}

/** Does this field participate in flags? */
function hasFlag (field) {
  // All bools (required or optional) get a flag bit
  if (field.type === 'bool') return true
  // Optional non-bool fields get a flag bit
  if (!field.required) return true
  return false
}

/** Does this field need a separate encode/decode (i.e., not just a flag bit)? */
function needsSeparateEncoding (field) {
  // Bools only live in the flag bits — no separate encoding
  if (field.type === 'bool') return false
  return true
}

/**
 * Compute varint byte count for a given max value.
 * compact-encoding uses: <=0xfc -> 1 byte, <=0xffff -> 3 bytes, <=0xffffffff -> 5 bytes, else 9
 */
function varintBytes (maxVal) {
  if (maxVal <= 0xfc) return 1
  if (maxVal <= 0xffff) return 3
  if (maxVal <= 0xffffffff) return 5
  return 9
}

// ---------------------------------------------------------------------------
// Frame codec — compact-encoding-swift does not have Frame, so we generate it inline
// ---------------------------------------------------------------------------

const FRAME_CODEC_HELPER = `
/// Frame codec: varint length prefix followed by inner data.
/// Matches the JS compact-encoding c.frame() implementation which uses
/// c.uint (varint) for the length, NOT c.uint32 (fixed 4 bytes).
public struct FrameCodec<Inner: Codec>: Codec {
  public typealias Value = Inner.Value

  private let inner: Inner
  private let _uint = Primitive.UInt()

  public init(_ inner: Inner) {
    self.inner = inner
  }

  public func preencode(_ state: inout State, _ value: Value) {
    // Match JS: preencode inner first, then preencode the varint length
    let start = state.end
    inner.preencode(&state, value)
    let innerLen = state.end - start
    _uint.preencode(&state, Swift.UInt(innerLen))
  }

  public func encode(_ state: inout State, _ value: Value) throws {
    // Match JS: measure inner size, write varint length, then encode inner
    var sub = State()
    inner.preencode(&sub, value)
    let innerLen = sub.end

    try _uint.encode(&state, Swift.UInt(innerLen))
    try inner.encode(&state, value)
  }

  public func decode(_ state: inout State) throws -> Value {
    let len = Int(try _uint.decode(&state))
    let end = state.start + len

    let savedEnd = state.end
    state.end = end
    let value = try inner.decode(&state)
    state.start = end
    state.end = savedEnd

    return value
  }
}
`

// ---------------------------------------------------------------------------
// Main codegen
// ---------------------------------------------------------------------------

function generateWireCompatibleSwiftSchema (schemaDir) {
  const schema = Hyperschema.from(schemaDir)
  const types = schema.schema

  const lines = []
  const push = (s = '') => lines.push(s)

  // Header
  push('// This file is autogenerated by swift-codegen.cjs')
  push('// Wire-compatible with the JS hyperschema compact-encoding output')
  push(`// Schema Version: ${schema.version}`)
  push('// !!DO NOT EDIT THIS FILE!!')
  push('')
  push('import CompactEncoding')
  push('import Foundation')
  push('')

  // Encode/decode helpers
  push('public func encode<C: Codec>(_ codec: C, _ value: C.Value) -> Data {')
  push('  var state = State()')
  push('  codec.preencode(&state, value)')
  push('  state.allocate()')
  push('  try! codec.encode(&state, value)')
  push('  return state.buffer')
  push('}')
  push('')
  push('public func decode<C: Codec>(_ codec: C, _ data: Data) throws -> C.Value {')
  push('  var state = State(data)')
  push('  return try codec.decode(&state)')
  push('}')
  push('')

  // Frame codec helper
  push(FRAME_CODEC_HELPER.trim())
  push('')

  // Build a map of type FQN -> index for referencing
  const typeMap = new Map()
  for (let i = 0; i < types.length; i++) {
    const t = types[i]
    const fqn = `@${t.namespace}/${t.name}`
    typeMap.set(fqn, { index: i, type: t })
  }

  // Generate each type
  for (let i = 0; i < types.length; i++) {
    const t = types[i]
    const fqn = `@${t.namespace}/${t.name}`
    const structName = pascalCase(t.name)
    // Special case: "Error" shadows Swift.Error
    const safeStructName = structName === 'Error' ? 'HRPCError' : structName
    const codecName = structName + 'Codec'
    const instanceName = structName === 'Error' ? 'hrpcError' : camelCase(t.name)

    push(`// ${fqn}`)

    // ---- Struct definition ----
    push(`public struct ${safeStructName} {`)
    for (const field of t.fields) {
      const swType = swiftFieldType(field)
      push(`  public var ${camelCase(field.name)}: ${swType}`)
    }
    push('')

    // Init
    if (t.fields.length === 0) {
      push(`  public init() {}`)
    } else {
      const params = t.fields.map(field => {
        const swType = swiftFieldType(field)
        const propName = camelCase(field.name)
        const defaultVal = fieldInitDefault(field)
        if (defaultVal !== null) {
          return `${propName}: ${swType} = ${defaultVal}`
        }
        return `${propName}: ${swType}`
      })
      push(`  public init(${params.join(', ')}) {`)
      for (const field of t.fields) {
        const propName = camelCase(field.name)
        push(`    self.${propName} = ${propName}`)
      }
      push('  }')
    }
    push('}')
    push('')

    // ---- Codec definition ----
    push(`public struct ${codecName}: Codec {`)
    push(`  public typealias Value = ${safeStructName}`)
    push('')

    // Codec instances needed
    const codecInstances = new Set()
    const fieldCodecInfo = [] // per-field codec info

    for (const field of t.fields) {
      const info = getFieldCodecInfo(field, typeMap)
      fieldCodecInfo.push(info)
      for (const inst of info.instances) {
        codecInstances.add(inst)
      }
    }

    // Declare codec instances
    const sortedInstances = [...codecInstances].sort()
    for (const inst of sortedInstances) {
      push(`  ${inst}`)
    }
    if (sortedInstances.length > 0) push('')

    push('  public init() {}')
    push('')

    // Compute flag-participating fields and their bit assignments
    const flagFields = []
    let flagBit = 1
    for (let fi = 0; fi < t.fields.length; fi++) {
      const field = t.fields[fi]
      if (hasFlag(field)) {
        flagFields.push({ fieldIndex: fi, field, bit: flagBit })
        flagBit <<= 1
      }
    }
    const maxFlag = flagBit >> 1 // highest bit value
    const hasFlags = flagFields.length > 0
    const flagsPosition = t.flagsPosition

    // ---- preencode ----
    push(`  public func preencode(_ state: inout State, _ value: ${safeStructName}) {`)
    if (hasFlags) {
      generatePreencode(push, t, flagFields, maxFlag, flagsPosition, fieldCodecInfo)
    } else {
      // No flags — encode all fields directly
      for (let fi = 0; fi < t.fields.length; fi++) {
        const field = t.fields[fi]
        const info = fieldCodecInfo[fi]
        push(`    ${info.preencodeExpr(`value.${camelCase(field.name)}`)}`)
      }
    }
    push('  }')
    push('')

    // ---- encode ----
    push(`  public func encode(_ state: inout State, _ value: ${safeStructName}) throws {`)
    if (hasFlags) {
      generateEncode(push, t, flagFields, flagsPosition, fieldCodecInfo)
    } else {
      for (let fi = 0; fi < t.fields.length; fi++) {
        const field = t.fields[fi]
        const info = fieldCodecInfo[fi]
        push(`    try ${info.encodeExpr(`value.${camelCase(field.name)}`)}`)
      }
    }
    push('  }')
    push('')

    // ---- decode ----
    push(`  public func decode(_ state: inout State) throws -> ${safeStructName} {`)
    if (hasFlags) {
      generateDecode(push, t, safeStructName, flagFields, flagsPosition, fieldCodecInfo)
    } else {
      if (t.fields.length === 0) {
        push(`    return ${safeStructName}()`)
      } else {
        push(`    return ${safeStructName}(`)
        for (let fi = 0; fi < t.fields.length; fi++) {
          const field = t.fields[fi]
          const info = fieldCodecInfo[fi]
          const comma = fi < t.fields.length - 1 ? ',' : ''
          push(`      ${camelCase(field.name)}: try ${info.decodeExpr()}${comma}`)
        }
        push('    )')
      }
    }
    push('  }')
    push('}')
    push('')

    // Singleton codec instance
    push(`public let ${instanceName} = ${codecName}()`)
    push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Field codec info
// ---------------------------------------------------------------------------

function getFieldCodecInfo (field, typeMap) {
  const instances = []
  let codecVar

  if (field.array) {
    if (isStructType(field.type)) {
      // Array of structs: array(frame(innerCodec))
      const innerCodecName = pascalCase(field.type) + 'Codec'
      codecVar = '_' + camelCase(field.name) + 'ArrayCodec'
      instances.push(`let ${codecVar} = Primitive.Array(FrameCodec(${innerCodecName}()))`)
    } else {
      // Array of primitives: array(codec)
      const primCodec = primitiveCodecExpr(field.type)
      codecVar = '_' + camelCase(field.name) + 'ArrayCodec'
      instances.push(`let ${codecVar} = Primitive.Array(${primCodec})`)
    }
  } else if (isStructType(field.type)) {
    // Struct reference: frame(innerCodec)
    const innerCodecName = pascalCase(field.type) + 'Codec'
    codecVar = '_' + camelCase(field.name) + 'Codec'
    instances.push(`let ${codecVar} = FrameCodec(${innerCodecName}())`)
  } else if (field.type === 'bool') {
    // Bool — encoded in flags, no codec instance needed
    codecVar = null
  } else {
    // Primitive
    const primCodec = primitiveCodecExpr(field.type)
    codecVar = '_' + camelCase(field.name) + 'Codec'
    instances.push(`let ${codecVar} = ${primCodec}`)
  }

  return {
    instances,
    codecVar,
    isBool: field.type === 'bool',

    preencodeExpr (valueExpr) {
      if (!codecVar) return '' // bool — no preencode
      return `${codecVar}.preencode(&state, ${valueExpr})`
    },
    encodeExpr (valueExpr) {
      if (!codecVar) return '' // bool
      return `${codecVar}.encode(&state, ${valueExpr})`
    },
    decodeExpr () {
      if (!codecVar) return '' // bool — decoded from flags
      return `${codecVar}.decode(&state)`
    }
  }
}

// ---------------------------------------------------------------------------
// Preencode generation
// ---------------------------------------------------------------------------

function generatePreencode (push, type, flagFields, maxFlag, flagsPosition, fieldCodecInfo) {
  // Determine whether we use state.end += N (constant) or _uint.preencode for flags
  const flagBytes = varintBytes(maxFlag)
  const useDynamicFlags = maxFlag > 0xfc // more than 1 byte → must compute flags

  if (useDynamicFlags) {
    // Need to compute flags value to determine varint size
    push('    // Compute flags for varint sizing')
    push('    var flags: UInt = 0')
    for (const ff of flagFields) {
      const field = ff.field
      const propName = `value.${camelCase(field.name)}`
      if (field.type === 'bool') {
        push(`    if ${propName} { flags |= ${ff.bit} }`)
      } else {
        push(`    if ${propName} != nil { flags |= ${ff.bit} }`)
      }
    }
    push('')
  }

  // Walk fields in declaration order, insert flags at flagsPosition
  let fieldIdx = 0
  let fieldOutputIdx = 0

  for (const field of type.fields) {
    // Insert flags at the right position
    if (fieldOutputIdx === flagsPosition) {
      if (useDynamicFlags) {
        push('    Primitive.UInt().preencode(&state, flags)')
      } else {
        push(`    state.end += ${flagBytes} // flags`)
      }
    }

    const info = fieldCodecInfo[fieldIdx]
    const propName = `value.${camelCase(field.name)}`

    if (field.type === 'bool') {
      // Bool — no preencode (encoded in flags)
    } else if (hasFlag(field)) {
      // Optional non-bool — conditional preencode
      push(`    if let v = ${propName} { ${info.codecVar}.preencode(&state, v) }`)
    } else {
      // Required non-bool — unconditional preencode
      push(`    ${info.preencodeExpr(propName)}`)
    }

    fieldIdx++
    fieldOutputIdx++
  }

  // Edge case: flagsPosition == field count (flags at the end)
  if (fieldOutputIdx === flagsPosition) {
    if (useDynamicFlags) {
      push('    Primitive.UInt().preencode(&state, flags)')
    } else {
      push(`    state.end += ${flagBytes} // flags`)
    }
  }
}

// ---------------------------------------------------------------------------
// Encode generation
// ---------------------------------------------------------------------------

function generateEncode (push, type, flagFields, flagsPosition, fieldCodecInfo) {
  // Build flags computation
  push('    var flags: UInt = 0')
  for (const ff of flagFields) {
    const field = ff.field
    const propName = `value.${camelCase(field.name)}`
    if (field.type === 'bool') {
      push(`    if ${propName} { flags |= ${ff.bit} }`)
    } else if (field.array) {
      push(`    if ${propName} != nil { flags |= ${ff.bit} }`)
    } else {
      push(`    if ${propName} != nil { flags |= ${ff.bit} }`)
    }
  }
  push('')

  const flagsCodec = 'Primitive.UInt()'

  // Walk fields in declaration order, insert flags encode at flagsPosition
  let fieldIdx = 0
  let fieldOutputIdx = 0

  for (const field of type.fields) {
    // Insert flags encode at the right position
    if (fieldOutputIdx === flagsPosition) {
      push(`    try ${flagsCodec}.encode(&state, flags)`)
    }

    const info = fieldCodecInfo[fieldIdx]
    const propName = `value.${camelCase(field.name)}`

    if (field.type === 'bool') {
      // Bool — encoded in flags, nothing to do
    } else if (hasFlag(field)) {
      // Optional non-bool — conditional encode
      if (field.array) {
        push(`    if let v = ${propName} { try ${info.codecVar}.encode(&state, v) }`)
      } else {
        push(`    if let v = ${propName} { try ${info.codecVar}.encode(&state, v) }`)
      }
    } else {
      // Required non-bool — unconditional encode
      push(`    try ${info.encodeExpr(propName)}`)
    }

    fieldIdx++
    fieldOutputIdx++
  }

  // Edge case: flagsPosition at the end
  if (fieldOutputIdx === flagsPosition) {
    push(`    try ${flagsCodec}.encode(&state, flags)`)
  }
}

// ---------------------------------------------------------------------------
// Decode generation
// ---------------------------------------------------------------------------

function generateDecode (push, type, safeStructName, flagFields, flagsPosition, fieldCodecInfo) {
  // We need temp variables for required fields decoded before later fields
  // and we need to read flags at the right position

  const tempVars = [] // { varName, decodeExpr, fieldIndex }
  let tempIdx = 0

  // First pass: identify which fields need temp vars
  // Required non-bool fields that appear before flagsPosition need temp vars
  // because they're decoded before flags
  const fieldOutputOrder = []
  let flagsInserted = false

  for (let fi = 0; fi < type.fields.length; fi++) {
    if (fi === flagsPosition && !flagsInserted) {
      fieldOutputOrder.push({ type: 'flags' })
      flagsInserted = true
    }
    fieldOutputOrder.push({ type: 'field', fieldIndex: fi })
  }
  if (!flagsInserted) {
    fieldOutputOrder.push({ type: 'flags' })
  }

  // Build decode statements
  const decodeStmts = []
  const fieldVarNames = new Map() // fieldIndex -> varName or inline
  const flagBitMap = new Map() // fieldIndex -> bit
  for (const ff of flagFields) {
    flagBitMap.set(ff.fieldIndex, ff.bit)
  }

  for (const item of fieldOutputOrder) {
    if (item.type === 'flags') {
      decodeStmts.push('    let flags = try Primitive.UInt().decode(&state)')
      continue
    }

    const fi = item.fieldIndex
    const field = type.fields[fi]
    const info = fieldCodecInfo[fi]
    const propName = camelCase(field.name)

    if (field.type === 'bool') {
      // Decoded from flags — no separate decode
      const bit = flagBitMap.get(fi)
      fieldVarNames.set(fi, `(flags & ${bit}) != 0`)
    } else if (hasFlag(field)) {
      // Optional non-bool — conditional decode
      const bit = flagBitMap.get(fi)
      const varName = '_r' + tempIdx++
      const defVal = defaultValue(field)
      decodeStmts.push(`    let ${varName}: ${swiftFieldType(field)} = (flags & ${bit}) != 0 ? try ${info.decodeExpr()} : ${defVal}`)
      fieldVarNames.set(fi, varName)
    } else {
      // Required non-bool — unconditional decode
      const varName = '_r' + tempIdx++
      decodeStmts.push(`    let ${varName} = try ${info.decodeExpr()}`)
      fieldVarNames.set(fi, varName)
    }
  }

  // Output decode statements
  for (const stmt of decodeStmts) {
    push(stmt)
  }

  // Build return
  if (type.fields.length === 0) {
    push(`    return ${safeStructName}()`)
  } else {
    push(`    return ${safeStructName}(`)
    for (let fi = 0; fi < type.fields.length; fi++) {
      const field = type.fields[fi]
      const propName = camelCase(field.name)
      const varRef = fieldVarNames.get(fi)
      const comma = fi < type.fields.length - 1 ? ',' : ''
      push(`      ${propName}: ${varRef}${comma}`)
    }
    push('    )')
  }
}

// ---------------------------------------------------------------------------
// Init default values
// ---------------------------------------------------------------------------

function fieldInitDefault (field) {
  if (field.type === 'bool') return 'false'
  if (!field.required) {
    return 'nil'
  }
  // Required fields — no default unless it's a sensible zero
  return null
}

module.exports = { generateWireCompatibleSwiftSchema }
