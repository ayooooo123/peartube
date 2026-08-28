import b4a from 'b4a'
import sodium from 'sodium-universal'

function sha256Bytes(value) {
  const bytes = b4a.isBuffer(value) ? value : b4a.from(value)
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, bytes)
  return digest
}

function hash(value) {
  return b4a.toString(sha256Bytes(value), 'hex')
}

function hmac(key, value) {
  let k = b4a.isBuffer(key) ? key : b4a.from(key)
  const msg = b4a.isBuffer(value) ? value : b4a.from(value)
  const blockSize = 64
  if (k.byteLength > blockSize) {
    k = sha256Bytes(k)
  }
  const paddedKey = b4a.alloc(blockSize)
  b4a.copy(k, paddedKey, 0)

  const innerPad = b4a.alloc(blockSize)
  const outerPad = b4a.alloc(blockSize)
  for (let i = 0; i < blockSize; i++) {
    innerPad[i] = paddedKey[i] ^ 0x36
    outerPad[i] = paddedKey[i] ^ 0x5c
  }

  const innerMsg = b4a.concat([innerPad, msg])
  const innerHash = sha256Bytes(innerMsg)
  const outerMsg = b4a.concat([outerPad, innerHash])
  return sha256Bytes(outerMsg)
}

function encode(value) { return encodeURIComponent(value).replace(/%2F/g, '/') }

export function createS3Signer({ endpoint, bucket, forcePathStyle = false, region = 'us-east-1', accessKeyId, secretAccessKey, service = 's3', now = () => new Date() } = {}) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new TypeError('S3 endpoint, bucket, and credentials are required')
  const origin = new URL(endpoint)
  return async ({ operation, key, method = operation === 'put' ? 'PUT' : operation === 'delete' ? 'DELETE' : operation === 'head' ? 'HEAD' : 'GET', headers = {} }) => {
    const url = new URL(origin)
    const encodedKey = String(key).split('/').map(encode).join('/')
    if (forcePathStyle) {
      url.pathname = `${origin.pathname.replace(/\/$/, '')}/${encode(bucket)}/${encodedKey}`
    } else {
      url.hostname = `${bucket}.${origin.hostname}`
      url.pathname = `${origin.pathname.replace(/\/$/, '')}/${encodedKey}`
    }
    const date = now()
    const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '').replace('Z', 'Z')
    const shortDate = amzDate.slice(0, 8)
    const signedHeaders = { host: url.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, ...headers }
    const canonicalHeaders = Object.keys(signedHeaders).sort().map(k => `${k.toLowerCase()}:${String(signedHeaders[k]).trim()}\n`).join('')
    const names = Object.keys(signedHeaders).map(k => k.toLowerCase()).sort().join(';')
    const canonical = [method, url.pathname || '/', '', canonicalHeaders, names, 'UNSIGNED-PAYLOAD'].join('\n')
    const scope = `${shortDate}/${region}/${service}/aws4_request`
    const credential = `${accessKeyId}/${scope}`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonical)}`
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, shortDate), region), service), 'aws4_request')
    const authorization = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${names}, Signature=${b4a.toString(hmac(signingKey, stringToSign), 'hex')}`
    return { url: url.toString(), headers: { ...signedHeaders, Authorization: authorization } }
  }
}
