import { createHash, createHmac } from 'node:crypto'

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function hmac(key, value) { return createHmac('sha256', key).update(value).digest() }
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
    const authorization = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${names}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`
    return { url: url.toString(), headers: { ...signedHeaders, Authorization: authorization } }
  }
}
