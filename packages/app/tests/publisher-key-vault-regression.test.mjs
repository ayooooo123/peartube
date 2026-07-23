import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

test('mobile publisher root vault is SecureStore-only and exposes no secret export path', () => {
  const source = readAppFile('lib/publisher-key-vault.ts')
  const pkg = readJson('packages/app/package.json')

  assert.equal(pkg.dependencies['expo-secure-store'], '~56.0.4')
  assert.match(source, /import\('expo-secure-store'\)/)
  assert.match(source, /createPublisherKeyVault/)
  assert.match(source, /createRoot/)
  assert.match(source, /importRoot/)
  assert.match(source, /getPublicKey/)
  assert.match(source, /signDigest/)
  assert.match(source, /deleteRoot/)
  assert.match(source, /AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/)
  assert.match(source, /keychainService:\s*PUBLISHER_ROOT_SERVICE/)
  assert.match(source, /redactPublisherVaultError/)

  assert.doesNotMatch(source, /secure-storage/)
  assert.doesNotMatch(source, /expo-file-system/)
  assert.doesNotMatch(source, /fallback(Get|Set|Delete|Uri)/)
  assert.doesNotMatch(source, /export\s+.*getSecret/)
  assert.doesNotMatch(source, /getSecret\s*\(/)
  assert.doesNotMatch(source, /console\.(log|warn|error)/)
})

test('desktop publisher root vault lives in the privileged Bun process and uses an OS keyring dependency', () => {
  const vaultSource = readAppFile('src/bun/publisher-key-vault.ts')
  const bunSource = readAppFile('src/bun/index.ts')
  const pkg = readJson('packages/app/package.json')

  assert.equal(pkg.dependencies['@napi-rs/keyring'], '^1.3.0')
  assert.match(vaultSource, /import\('@napi-rs\/keyring'\)/)
  assert.match(vaultSource, /new keyring\.AsyncEntry\(/)
  assert.match(vaultSource, /setPassword/)
  assert.match(vaultSource, /getPassword/)
  assert.match(vaultSource, /deletePassword|deleteCredential/)
  assert.match(vaultSource, /createBunPublisherKeyVault/)
  assert.match(vaultSource, /redactPublisherVaultError/)
  assert.match(bunSource, /createBunPublisherKeyVault/)
  assert.match(bunSource, /const publisherKeyVault = createBunPublisherKeyVault/)

  assert.doesNotMatch(vaultSource, /from 'fs'|from "fs"|from 'path'|from "path"|homedir\(/)
  assert.doesNotMatch(vaultSource, /getSecret\s*\(/)
  assert.doesNotMatch(vaultSource, /export\s+.*getSecret/)
  assert.doesNotMatch(bunSource, /getSecret|publisherVaultGetSecret|rootSecret/)
})
