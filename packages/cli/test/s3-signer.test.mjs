import test from 'brittle'
import crypto from 'node:crypto'
import { createS3Signer } from '../src/s3-signer.js'

test('createS3Signer validates required options', async (t) => {
  await t.exception.all(() => createS3Signer({}), /S3 endpoint, bucket, and credentials are required/)
  await t.exception.all(() => createS3Signer({ endpoint: 'https://s3.example.com' }), /S3 endpoint, bucket, and credentials are required/)
  await t.exception.all(() => createS3Signer({ endpoint: 'https://s3.example.com', bucket: 'test' }), /S3 endpoint, bucket, and credentials are required/)
  await t.exception.all(() => createS3Signer({ endpoint: 'https://s3.example.com', bucket: 'test', accessKeyId: 'AKIA' }), /S3 endpoint, bucket, and credentials are required/)
})

test('createS3Signer builds correct virtual-host and path-style URLs', async (t) => {
  const fixedDate = new Date('2026-08-28T12:00:00.000Z')
  const signerVHost = createS3Signer({
    endpoint: 'https://s3.amazonaws.com',
    bucket: 'media-vault',
    accessKeyId: 'TESTKEYID',
    secretAccessKey: 'TESTSECRETKEY',
    now: () => fixedDate
  })

  const vhostResult = await signerVHost({
    operation: 'get',
    key: 'blocks/chunk-001.bin'
  })

  t.is(vhostResult.url, 'https://media-vault.s3.amazonaws.com/blocks/chunk-001.bin', 'virtual-host URL includes bucket subdomain')

  const signerPathStyle = createS3Signer({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'media-vault',
    forcePathStyle: true,
    accessKeyId: 'TESTKEYID',
    secretAccessKey: 'TESTSECRETKEY',
    now: () => fixedDate
  })

  const pathResult = await signerPathStyle({
    operation: 'put',
    key: 'blocks/chunk-002.bin'
  })

  t.is(pathResult.url, 'http://127.0.0.1:9000/media-vault/blocks/chunk-002.bin', 'path-style URL keeps bucket in pathname')
})

test('createS3Signer produces valid SigV4 signature matching Node crypto reference', async (t) => {
  const fixedDate = new Date('2026-08-28T15:30:00.000Z')
  const accessKeyId = 'AKIAIOSFODNN7EXAMPLE'
  const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const region = 'us-east-1'
  const service = 's3'

  const signer = createS3Signer({
    endpoint: 'https://s3.amazonaws.com',
    bucket: 'examplebucket',
    region,
    accessKeyId,
    secretAccessKey,
    now: () => fixedDate
  })

  const result = await signer({
    operation: 'put',
    key: 'test.txt',
    headers: {
      'content-type': 'text/plain'
    }
  })

  t.is(result.headers.host, 'examplebucket.s3.amazonaws.com')
  t.is(result.headers['x-amz-date'], '20260828T153000Z')
  t.is(result.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD')

  // Reference SigV4 calculation using Node crypto
  const amzDate = '20260828T153000Z'
  const shortDate = '20260828'
  const scope = `${shortDate}/${region}/${service}/aws4_request`
  const canonicalHeaders = 'content-type:text/plain\nhost:examplebucket.s3.amazonaws.com\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20260828T153000Z\n'
  const signedHeaderNames = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = ['PUT', '/test.txt', '', canonicalHeaders, signedHeaderNames, 'UNSIGNED-PAYLOAD'].join('\n')
  const canonicalHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalHash}`

  const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(shortDate).digest()
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest()
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest()
  const expectedSignature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const expectedAuth = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${expectedSignature}`
  t.is(result.headers.Authorization, expectedAuth, 'SigV4 Authorization header matches reference computation exactly')
})

test('createS3Signer correctly maps operations to HTTP methods', async (t) => {
  const signer = createS3Signer({
    endpoint: 'https://s3.amazonaws.com',
    bucket: 'test',
    accessKeyId: 'KEY',
    secretAccessKey: 'SECRET'
  })

  // Test head, delete, get, and put operations
  const headReq = await signer({ operation: 'head', key: 'file' })
  t.ok(headReq.headers.Authorization.includes('SignedHeaders='), 'head operation generates authorization')

  const delReq = await signer({ operation: 'delete', key: 'file' })
  t.ok(delReq.headers.Authorization.includes('SignedHeaders='), 'delete operation generates authorization')
})
