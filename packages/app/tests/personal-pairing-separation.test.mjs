/**
 * Personal-store pairing must stay separated from publisher-channel pairing.
 *
 * Two pairing flows exist and they grant very different things:
 *   - Personal-store pairing moves the viewer's own encrypted watch state,
 *     library, and the 32-byte keychain secret to a device they linked.
 *   - Publisher-channel pairing grants another device authority to publish to
 *     a channel, keyed by the identity's drive key.
 *
 * Profile is the consumer surface and may only ever reach the first. The
 * second stays in Studio, behind Developer Mode. This file pins that split by
 * source scan, and pins the key-custody rules by running the real module.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const appRoot = path.resolve(import.meta.dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), 'utf8')

const profile = read('app/profile.tsx')
const studio = read('app/(tabs)/studio.tsx')

/** Publisher-channel pairing RPCs. A channel key is the blast radius. */
const PUBLISHER_PAIRING = [
  ['createDeviceInvite', /(?<![\w])createDeviceInvite\s*\(/],
  ['pairDevice', /(?<![\w])pairDevice\s*\(/],
  ['listDevices', /(?<![\w])listDevices\s*\(/],
]

/** Personal-store pairing RPCs. Only the viewer's own encrypted state moves. */
const PERSONAL_PAIRING = [
  ['createPersonalDeviceInvite', /rpc\.createPersonalDeviceInvite\s*\(/],
  ['redeemPersonalDeviceInvite', /rpc\.redeemPersonalDeviceInvite\s*\(/],
  ['listPersonalDevices', /rpc\.listPersonalDevices\s*\(/],
  ['revokePersonalDevice', /rpc\.revokePersonalDevice\s*\(/],
]

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `expected to find ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `expected to find ${endMarker} after ${startMarker}`)
  return source.slice(start, end)
}

const pairingHandlers = sliceBetween(profile, 'const createPersonalInvite', 'const applyStorageLimit')

async function loadPersonalEncryption(instance) {
  const result = await build({
    entryPoints: [path.join(appRoot, 'lib/personal-encryption.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['expo-secure-store', 'expo-file-system'],
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-pairing-'))
  const output = path.join(directory, `${instance}.cjs`)
  fs.writeFileSync(output, result.outputFiles[0].text)
  const loaded = await import(pathToFileURL(output).href)
  fs.rmSync(directory, { recursive: true, force: true })
  return loaded
}

/** Stand in for the desktop keyring bridge that secure-storage prefers. */
function installVault({ dropWrites = false } = {}) {
  const values = new Map()
  const writes = []
  globalThis.window = {
    bridge: {
      personalSecureGet: async (key) => (values.has(key) ? values.get(key) : null),
      personalSecureSet: async (key, value) => {
        writes.push({ key, value })
        if (!dropWrites) values.set(key, value)
      },
      personalSecureDelete: async (key) => { values.delete(key) },
    },
  }
  return { values, writes, restore() { delete globalThis.window } }
}

/**
 * Load the real secure-storage + personal-encryption pair against a stubbed
 * expo-secure-store, i.e. the mobile keychain branch.
 *
 * The desktop-bridge stub above cannot exercise custody failures end to end:
 * it is the first branch secure-storage takes, so it never reaches the keychain
 * or the document-directory path that used to catch a thrown write. The stubs
 * are installed as real packages beside the bundle so the module's own dynamic
 * imports resolve to them — including expo-file-system, whose writes are
 * recorded rather than blocked, so a plaintext downgrade shows up as evidence
 * instead of disappearing.
 */
const keychainSlots = new Map()
const keychainDirectories = []
process.on('exit', () => {
  for (const directory of keychainDirectories) fs.rmSync(directory, { recursive: true, force: true })
})

function installKeychain(instance, { values = new Map(), acceptWrites = true, throwOnWrite = false } = {}) {
  const writes = []
  const fileWrites = []
  const files = new Map()
  const keychain = {
    values,
    writes,
    fileWrites,
    async getItemAsync(key) { return values.has(key) ? values.get(key) : null },
    async setItemAsync(key, value) {
      writes.push({ key, value })
      if (throwOnWrite) throw new Error('keychain refused the write')
      if (acceptWrites) values.set(key, value)
    },
    async deleteItemAsync(key) { values.delete(key) },
    async writeFile(uri, value) { fileWrites.push({ uri, value }); files.set(uri, value) },
    async readFile(uri) {
      if (!files.has(uri)) throw new Error('missing')
      return files.get(uri)
    },
    async deleteFile(uri) { files.delete(uri) },
  }
  keychainSlots.set(instance, keychain)
  return keychain
}

async function loadAgainstKeychain(instance) {
  const result = await build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(appRoot, 'lib/secure-storage.ts'))}`,
        `export * from ${JSON.stringify(path.join(appRoot, 'lib/personal-encryption.ts'))}`,
      ].join('\n'),
      resolveDir: appRoot,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['expo-secure-store', 'expo-file-system'],
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-keychain-'))
  keychainDirectories.push(directory)
  const slot = JSON.stringify(instance)
  // `exports.name = …` so Node's CJS named-export detection sees them through
  // the module's own dynamic import.
  const packages = {
    'expo-secure-store': `
const slot = () => globalThis.__peartubeKeychains.get(${slot})
exports.getItemAsync = (key) => slot().getItemAsync(key)
exports.setItemAsync = (key, value) => slot().setItemAsync(key, value)
exports.deleteItemAsync = (key) => slot().deleteItemAsync(key)
`,
    'expo-file-system': `
const slot = () => globalThis.__peartubeKeychains.get(${slot})
exports.documentDirectory = 'file:///peartube-documents/'
exports.writeAsStringAsync = (uri, value) => slot().writeFile(uri, value)
exports.readAsStringAsync = (uri) => slot().readFile(uri)
exports.deleteAsync = (uri) => slot().deleteFile(uri)
`,
  }
  for (const [name, source] of Object.entries(packages)) {
    const packageDirectory = path.join(directory, 'node_modules', name)
    fs.mkdirSync(packageDirectory, { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.cjs' }))
    fs.writeFileSync(path.join(packageDirectory, 'index.cjs'), source)
  }
  const output = path.join(directory, `${instance}.cjs`)
  fs.writeFileSync(output, result.outputFiles[0].text)
  globalThis.__peartubeKeychains = keychainSlots
  delete globalThis.window // no desktop bridge: this is the keychain branch
  return import(pathToFileURL(output).href)
}

test('Profile drives every device control through the personal-store pairing RPCs', () => {
  for (const [name, pattern] of PERSONAL_PAIRING) {
    assert.match(profile, pattern, `Profile must call rpc.${name}`)
  }
  assert.match(pairingHandlers, /expiresInMs: PERSONAL_INVITE_TTL_MS/, 'invites are minted with an explicit bounded lifetime')
  assert.match(profile, /rpc\.listPersonalDevices\(\)/, 'the device list needs no channel key at all')
})

test('Profile never reaches publisher-channel pairing, with or without a channel key', () => {
  for (const [name, pattern] of PUBLISHER_PAIRING) {
    assert.doesNotMatch(profile, pattern, `Profile must not call publisher ${name}`)
  }
  assert.doesNotMatch(pairingHandlers, /driveKey/, 'no identity drive key may enter a pairing request')
  assert.doesNotMatch(pairingHandlers, /channelKey/, 'no channel key may enter a pairing request')
})

test('Studio keeps publisher-channel pairing, gated by Developer Mode', () => {
  assert.match(studio, /rpc\.createDeviceInvite\(identity\.driveKey\)/, 'channel invites are minted from the channel key in Studio')
  assert.match(studio, /rpc\.pairDevice\(\{[\s\S]*?inviteCode: code/, 'Studio redeems channel invites')
  assert.match(studio, /rpc\.listDevices\(identity\.driveKey\)/, 'Studio lists the channel devices')
  assert.match(
    studio,
    /<DeveloperModeGate>\s*<StudioScreen \/>\s*<\/DeveloperModeGate>/,
    'publisher pairing stays behind the existing Developer Mode gate',
  )
})

test('Studio never touches the viewer personal-store pairing', () => {
  for (const [name] of PERSONAL_PAIRING) {
    assert.doesNotMatch(studio, new RegExp(`\\b${name}\\s*\\(`), `Studio must not call ${name}`)
  }
})

test('a redeemed secret is persisted before sync and never rendered, logged, or shared', () => {
  const redeem = sliceBetween(profile, 'const linkThisDevice', 'const unlinkDevice')

  const persistAt = redeem.indexOf('await persistPersonalSecret(res.secret')
  const provisionAt = redeem.indexOf('await ensurePersonalEncryption(')
  assert.notEqual(persistAt, -1, 'the redeemed secret must be written to the device keychain')
  assert.notEqual(provisionAt, -1, 'sync is enabled by provisioning the store afterwards')
  assert.ok(persistAt < provisionAt, 'the keychain write must complete before the store is opened')
  assert.match(redeem, /res\.secret = ''/, 'the response copy is dropped once persisted')

  // The secret may reach the keychain and nothing else.
  assert.doesNotMatch(
    profile,
    /(console\.\w+|notify|JSON\.stringify|Share\.share|setStringAsync|setInviteCode|setState)\([^)]*\bsecret\b/,
    'the secret must never be logged, rendered, copied, shared, or serialized',
  )
  assert.doesNotMatch(profile, /useState[^\n]*[Ss]ecret/, 'the secret must never enter component state')
})

test('revocation mints a fresh platform secret and admits it is forward-only', () => {
  const revoke = sliceBetween(profile, 'const unlinkDevice', 'const applyStorageLimit')

  assert.match(revoke, /const secret = generatePersonalSecretHex\(\)/, 'the platform generates the next epoch secret')
  const generateAt = revoke.indexOf('generatePersonalSecretHex()')
  const persistAt = revoke.indexOf('await persistPersonalSecret(secret')
  const requestAt = revoke.indexOf('rpc.revokePersonalDevice(')
  assert.ok(generateAt < persistAt, 'the fresh secret is minted before it is stored')
  assert.ok(
    persistAt < requestAt,
    'the rotation key must be durable before the backend rotates onto it: the old key dies the moment it does',
  )
  assert.match(revoke, /rpc\.revokePersonalDevice\(\{[\s\S]*?keyHex,[\s\S]*?secret,/, 'revocation sends the new secret with the revoked key')
  assert.match(
    revoke,
    /previousSecret: previous\?\.secret/,
    'the pre-rotation key rides along as the one startup fallback',
  )
  assert.match(
    revoke,
    /if \(previous\) await persistPersonalSecret\(previous\.secret/,
    'a refusal raised before anything was written puts the still-live key back',
  )
  const ambiguousAt = revoke.indexOf('res?.error === ROTATION_ALREADY_RECORDED')
  const restoreAt = revoke.indexOf('if (previous) await persistPersonalSecret(previous.secret')
  assert.ok(ambiguousAt !== -1 && ambiguousAt < restoreAt, 'the recorded-epoch outcome is handled before the rollback path')
  assert.match(
    profile,
    /const ROTATION_ALREADY_RECORDED = 'personal-revoke-incomplete'/,
    'only the code that means the epoch is already durable skips the rollback',
  )
  assert.doesNotMatch(
    profile,
    /'personal-revoke-failed'|'personal-epoch-unavailable'/,
    'refusals raised with nothing written must take the ordinary restore path, not the keep-new-key path',
  )
  assert.match(
    profile,
    /cannot take that back|cannot erase what that device already read/,
    'the confirmation and privacy copy must not promise retroactive erasure',
  )
})

test('a device without a secure vault stays device-local instead of degrading', () => {
  assert.match(profile, /hasSecureVault\(\)/, 'the screen probes for a real OS vault')
  for (const handler of ['const createPersonalInvite', 'const linkThisDevice', 'const unlinkDevice']) {
    const body = sliceBetween(profile, handler, '\n  }\n')
    assert.match(body, /vaultAvailable !== true/, `${handler} must refuse to run without a vault`)
  }
  assert.match(profile, /disabled=\{inviteLoading \|\| !vaultReady\}/, 'the invite control is disabled without a vault')
  assert.match(profile, /disabled=\{pairing \|\| !pairInviteCode\.trim\(\) \|\| !vaultReady\}/, 'the redeem control is disabled without a vault')
  assert.match(profile, /no secure keychain/, 'the screen says plainly why linking is unavailable')
})

test('the privacy copy states the P2P, provider, and revocation limits without claiming anonymity', () => {
  assert.match(profile, /stay on this device/, 'local-by-default is stated')
  assert.match(profile, /IP address/, 'P2P address exposure is stated')
  assert.match(profile, /topics and byte ranges/, 'requested topics and ranges are stated')
  assert.match(profile, /authentication and license services/, 'provider visibility is stated')
  assert.match(profile, /not anonymous browsing/, 'anonymity is explicitly disclaimed')
  assert.doesNotMatch(profile, /completely anonymous|fully anonymous|no one can see/, 'no anonymity claim')
})

test('personal invites expire within five minutes', () => {
  const ttl = /const PERSONAL_INVITE_TTL_MS = ([^\n]+)/.exec(profile)
  assert.ok(ttl, 'the invite lifetime must be a named constant')
  // eslint-disable-next-line no-new-func -- evaluating a numeric literal expression from our own source
  const value = Function(`"use strict"; return (${ttl[1]})`)()
  assert.equal(typeof value, 'number')
  assert.ok(value > 0 && value <= 5 * 60 * 1000, `invite lifetime must be within five minutes, got ${value}`)
})

test('the platform mints personal secrets from 32 bytes of CSPRNG entropy', async () => {
  const { generatePersonalSecretHex } = await loadPersonalEncryption('generate')
  const first = generatePersonalSecretHex()
  const second = generatePersonalSecretHex()

  assert.match(first, /^[0-9a-f]{64}$/, '32 bytes, hex encoded')
  assert.match(second, /^[0-9a-f]{64}$/)
  assert.notEqual(first, second, 'each call must draw fresh entropy')
})

test('a personal secret is stored per identity and confirmed durable before use', async () => {
  const vault = installVault()
  try {
    const { persistPersonalSecret, personalSecretKeychainKey } = await loadPersonalEncryption('persist')
    const secret = 'ab'.repeat(32)
    const publicKey = 'cd'.repeat(32)

    await persistPersonalSecret(secret, { publicKey, bootstrapKey: 'ef'.repeat(32) })

    const key = personalSecretKeychainKey(publicKey)
    assert.equal(key, `peartube.personal.enc.${publicKey}`)
    assert.notEqual(key, personalSecretKeychainKey(null), 'identity and device-local slots stay distinct')
    assert.deepEqual(JSON.parse(vault.values.get(key)), { secret, bootstrapKey: 'ef'.repeat(32) })
    assert.equal(vault.writes.length, 1, 'one durable write, not a plaintext fallback copy too')
  } finally {
    vault.restore()
  }
})

test('a malformed or undurable secret is rejected rather than half-applied', async () => {
  const vault = installVault()
  try {
    const { persistPersonalSecret } = await loadPersonalEncryption('reject')
    await assert.rejects(() => persistPersonalSecret('not-a-secret'), /personal-secret-malformed/)
    await assert.rejects(() => persistPersonalSecret('ab'.repeat(31)), /personal-secret-malformed/)
    assert.equal(vault.writes.length, 0, 'a malformed secret never reaches the vault')
  } finally {
    vault.restore()
  }

  const dropping = installVault({ dropWrites: true })
  try {
    const { persistPersonalSecret } = await loadPersonalEncryption('undurable')
    await assert.rejects(
      () => persistPersonalSecret('ab'.repeat(32), { publicKey: 'cd'.repeat(32) }),
      /personal-secret-not-durable/,
      'a vault that silently drops the write must not be treated as custody',
    )
  } finally {
    dropping.restore()
  }
})

test('the vault record reads back in both stored shapes, so rotation can roll back', async () => {
  const vault = installVault()
  try {
    const { persistPersonalSecret, personalSecretKeychainKey, readPersonalSecretRecord } =
      await loadPersonalEncryption('read-back')
    const publicKey = 'cd'.repeat(32)
    const secret = 'ab'.repeat(32)

    assert.equal(await readPersonalSecretRecord(publicKey), null, 'an empty slot reads as nothing, not as a broken record')

    await persistPersonalSecret(secret, { publicKey, bootstrapKey: 'ef'.repeat(32) })
    assert.deepEqual(await readPersonalSecretRecord(publicKey), { secret, bootstrapKey: 'ef'.repeat(32) })

    // An older build stored the bare secret for an identity slot.
    vault.values.set(personalSecretKeychainKey(publicKey), secret)
    assert.deepEqual(await readPersonalSecretRecord(publicKey), { secret }, 'a legacy bare secret is still recoverable')
  } finally {
    vault.restore()
  }
})

test('an interrupted rotation prefers the new epoch key and falls back only if it never existed', async () => {
  const vault = installVault()
  try {
    const { persistPersonalSecret, personalSecretKeychainKey, ensurePersonalEncryption } =
      await loadPersonalEncryption('rotation-fallback')
    const publicKey = 'cd'.repeat(32)
    const rotated = 'ab'.repeat(32)
    const previousSecret = 'ba'.repeat(32)
    const key = personalSecretKeychainKey(publicKey)

    await persistPersonalSecret(rotated, { publicKey, previousSecret })
    assert.equal(JSON.parse(vault.values.get(key)).previousSecret, previousSecret)

    // The rotation did land: the new key opens the store and the fallback goes.
    const tried = []
    await ensurePersonalEncryption({
      provisionPersonalEncryption: async (req) => {
        tried.push(req.secret)
        return { success: true, bootstrapKey: 'ef'.repeat(32) }
      },
    }, publicKey, { force: true, required: true })
    assert.deepEqual(tried, [rotated], 'the rotated-to key is always tried first')
    assert.deepEqual(JSON.parse(vault.values.get(key)), { secret: rotated, bootstrapKey: 'ef'.repeat(32) })

    // The rotation never happened: the pre-rotation key is the live one.
    await persistPersonalSecret(rotated, { publicKey, previousSecret })
    const secondTry = []
    await ensurePersonalEncryption({
      provisionPersonalEncryption: async (req) => {
        secondTry.push(req.secret)
        return req.secret === previousSecret ? { success: true } : { success: false, error: 'store-already-unencrypted' }
      },
    }, publicKey, { force: true, required: true })
    assert.deepEqual(secondTry, [rotated, previousSecret], 'the fallback is tried only after the new key fails')
    assert.deepEqual(JSON.parse(vault.values.get(key)), { secret: previousSecret }, 'whichever key opened the store becomes the only one kept')
  } finally {
    vault.restore()
  }
})

test('a keychain that refuses the write stores the secret nowhere and leaves pairing off', async () => {
  const keychain = installKeychain('refused-write', { throwOnWrite: true })
  const { ensurePersonalEncryption, hasSecureVault } = await loadAgainstKeychain('refused-write')
  const provisionRequests = []
  const rpc = {
    provisionPersonalEncryption: async (request) => {
      provisionRequests.push(request)
      return { success: true, encrypted: true }
    },
  }

  await assert.rejects(
    () => ensurePersonalEncryption(rpc, 'cd'.repeat(32), { required: true }),
    /secure-vault-write-failed/,
    'a keychain that throws is a custody failure, not a prompt to store the key elsewhere',
  )

  assert.equal(keychain.values.size, 0, 'nothing landed in the keychain')
  assert.deepEqual(keychain.fileWrites, [], 'and nothing was written to the document directory beside the cores it encrypts')
  assert.deepEqual(provisionRequests, [], 'the backend never sees a secret this device cannot hold')
  assert.equal(await hasSecureVault(), false, 'so the screen keeps pairing disabled')
})

test('hasSecureVault answers false unless a probe actually reads back', async () => {
  const dropping = installKeychain('probe-dropped', { acceptWrites: false })
  const dropped = await loadAgainstKeychain('probe-dropped')
  assert.equal(
    await dropped.hasSecureVault(),
    false,
    'a keychain that accepts writes and returns nothing is presence without custody',
  )
  assert.ok(dropping.writes.length > 0, 'custody was actually attempted, not inferred from the module being installed')

  const working = installKeychain('probe-kept')
  const held = await loadAgainstKeychain('probe-kept')
  assert.equal(await held.hasSecureVault(), true, 'a keychain that hands the probe back has custody')
  assert.equal(working.values.size, 0, 'the probe is cleaned up rather than left in the vault')
})

test('the first device proves the key survived the keychain before sync is enabled', async () => {
  const dropping = installKeychain('first-device-dropped', { acceptWrites: false })
  const undurable = await loadAgainstKeychain('first-device-dropped')
  let provisionCalls = 0
  await assert.rejects(
    () => undurable.ensurePersonalEncryption({
      provisionPersonalEncryption: async () => { provisionCalls++; return { success: true, encrypted: true } },
    }, 'cd'.repeat(32), { required: true }),
    /personal-secret-not-durable/,
    'a first-device write that does not read back must not open a store nobody can reopen',
  )
  assert.equal(provisionCalls, 0, 'sync stays off until the key is durable')
  assert.ok(dropping.writes.length > 0)

  const keychain = installKeychain('first-device-durable')
  const { ensurePersonalEncryption, personalSecretKeychainKey } = await loadAgainstKeychain('first-device-durable')
  const publicKey = 'cd'.repeat(32)
  const requests = []
  await ensurePersonalEncryption({
    provisionPersonalEncryption: async (request) => {
      requests.push(request)
      return { success: true, encrypted: true, bootstrapKey: 'ef'.repeat(32) }
    },
  }, publicKey, { required: true })

  assert.equal(requests.length, 1)
  assert.match(requests[0].secret, /^[0-9a-f]{64}$/)
  assert.deepEqual(
    JSON.parse(keychain.values.get(personalSecretKeychainKey(publicKey))),
    { secret: requests[0].secret, bootstrapKey: 'ef'.repeat(32) },
    'an identity slot holds the same verified record shape as device-local, not a bare hex string',
  )
})
