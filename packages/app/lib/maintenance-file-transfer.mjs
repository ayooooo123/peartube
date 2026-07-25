const DEFAULT_MAX_IMPORT_BYTES = 1_500_000

function requireBytes(value, maxBytes = Number.MAX_SAFE_INTEGER) {
  let bytes
  if (value instanceof Uint8Array) bytes = value
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  else throw new Error('File data is unavailable')

  if (bytes.byteLength === 0) throw new Error('File is empty')
  if (bytes.byteLength > maxBytes) throw new Error(`File is too large (maximum ${maxBytes} bytes)`)
  return bytes
}

function safeFileName(value) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).pop() : ''
  const safe = name?.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 96)
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid file name')
  return safe
}

export function bytesToBase64(value) {
  const bytes = requireBytes(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index])
  }
  if (typeof btoa === 'function') return btoa(binary)
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  throw new Error('Base64 encoding is unavailable')
}

export function base64ToBytes(value, maxBytes = DEFAULT_MAX_IMPORT_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error('Invalid file encoding')
  }
  let binary
  try {
    if (typeof atob === 'function') binary = atob(value)
    else if (typeof Buffer !== 'undefined') binary = Buffer.from(value, 'base64').toString('binary')
    else throw new Error('Base64 decoding is unavailable')
  } catch {
    throw new Error('Invalid file encoding')
  }
  if (binary.length > maxBytes) throw new Error(`File is too large (maximum ${maxBytes} bytes)`)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return requireBytes(bytes, maxBytes)
}

function defaultWebAdapter() {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Browser download is unavailable')
  }
  return {
    createBlob: (parts, options) => new Blob(parts, options),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    clickDownload: (url, fileName) => {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    },
  }
}

export async function saveBytesToFile({
  platform,
  bytes: input,
  fileName: requestedName,
  mimeType = 'application/octet-stream',
  web,
  native,
}) {
  const bytes = requireBytes(input)
  const fileName = safeFileName(requestedName)
  if (platform === 'web') {
    const adapter = web || defaultWebAdapter()
    const blob = adapter.createBlob([bytes], { type: mimeType })
    const url = adapter.createObjectURL(blob)
    try {
      await adapter.clickDownload(url, fileName)
    } finally {
      adapter.revokeObjectURL(url)
    }
    return { fileName, uri: url, byteLength: bytes.byteLength }
  }

  if (!native || typeof native.writeBase64File !== 'function' || typeof native.shareFile !== 'function') {
    throw new Error('Native file export is unavailable')
  }
  const uri = await native.writeBase64File(fileName, bytesToBase64(bytes), mimeType)
  await native.shareFile(uri, fileName, mimeType)
  return { fileName, uri, byteLength: bytes.byteLength }
}

async function readWebAsset(asset) {
  if (asset?.file && typeof asset.file.arrayBuffer === 'function') return new Uint8Array(await asset.file.arrayBuffer())
  if (typeof asset?.uri === 'string' && typeof fetch === 'function') {
    const response = await fetch(asset.uri)
    if (!response.ok) throw new Error('Selected file could not be read')
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('Selected file could not be read')
}

export async function selectBytesFromFile({
  platform,
  pickDocument,
  maxBytes = DEFAULT_MAX_IMPORT_BYTES,
  native,
}) {
  if (typeof pickDocument !== 'function') throw new Error('Document selection is unavailable')
  const result = await pickDocument()
  if (result?.canceled === true || result?.cancelled === true) return null
  const asset = result?.assets?.[0] || result
  if (!asset || typeof asset !== 'object') throw new Error('No file was selected')
  const declaredSize = Number.isFinite(asset.size)
    ? asset.size
    : Number.isFinite(asset.file?.size)
      ? asset.file.size
      : null
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw new Error(`File is too large (maximum ${maxBytes} bytes)`)
  }

  let bytes
  if (platform === 'web') {
    bytes = await readWebAsset(asset)
  } else {
    if (!native || typeof native.readBase64File !== 'function' || typeof asset.uri !== 'string') {
      throw new Error('Native file import is unavailable')
    }
    bytes = base64ToBytes(await native.readBase64File(asset.uri, maxBytes), maxBytes)
  }
  return { fileName: safeFileName(asset.name || 'peartube-portable-state.json'), bytes: requireBytes(bytes, maxBytes) }
}
