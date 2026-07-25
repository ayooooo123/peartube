import test from 'brittle'
import crypto from 'hypercore-crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import {
  BOOTSTRAP_LOCATOR_RECORD_TYPE,
  createBootstrapLocator,
  verifyBootstrapLocator,
} from '../src/discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const fixtureRoot = path.join(here, 'fixtures/anti-centralization')
const productionRoots = [
  'packages/backend/src',
  'packages/backend/lib',
  'packages/app/app',
  'packages/app/backend',
  'packages/app/components',
  'packages/app/hooks',
  'packages/app/lib',
  'packages/app/src',
  'packages/cli/src',
  'packages/core/src',
  'packages/host/src',
  'packages/platform/src',
]
const sourceExtension = /\.(?:cjs|js|mjs|ts|tsx)$/
const keyLiteral = /^(?:[0-9a-f]{64}|[ybndrfg8ejkmcpqxot1uwisza345h769]{52})$/i
const remoteUrlLiteral = /^(?:https?|wss?):\/\/(?!localhost(?::|\/|$)|127(?:\.\d{1,3}){3}(?::|\/|$)|\[::1\](?::|\/|$))/i

function walkSourceFiles(directory, files = []) {
  if (!fs.existsSync(directory)) return files
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests' || entry.name === 'fixtures') continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) walkSourceFiles(absolute, files)
    else if (sourceExtension.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(absolute)
  }
  return files
}

function readSourceFile(absolute) {
  return {
    path: path.relative(repoRoot, absolute).split(path.sep).join('/'),
    source: fs.readFileSync(absolute, 'utf8'),
  }
}

function productionSourceFiles() {
  const override = process.env.PEARTUBE_CENTRALIZATION_GUARD_TARGET
  if (override) return [readSourceFile(path.resolve(repoRoot, override))]
  return productionRoots.flatMap(relative => walkSourceFiles(path.join(repoRoot, relative))).map(readSourceFile)
}

function parseSource(file) {
  const extension = path.extname(file.path)
  const scriptKind = extension === '.tsx'
    ? ts.ScriptKind.TSX
    : extension === '.ts'
      ? ts.ScriptKind.TS
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, scriptKind)
}

function nodeName(node) {
  if (!node) return ''
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${nodeName(node.expression)}.${nodeName(node.name)}`
  if (ts.isElementAccessExpression(node)) return `${nodeName(node.expression)}.${nodeName(node.argumentExpression)}`
  if (ts.isBindingElement(node)) return nodeName(node.name)
  return ''
}

function normalizedName(node) {
  return nodeName(node).replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function visitDescendants(node, visitor) {
  visitor(node)
  ts.forEachChild(node, child => visitDescendants(child, visitor))
}

function stringLiterals(node) {
  const values = []
  if (!node) return values
  visitDescendants(node, current => {
    if (ts.isStringLiteralLike(current)) values.push(current.text.trim())
  })
  return values
}

function containsDirectProcessEnv(node) {
  let found = false
  if (!node) return found
  visitDescendants(node, current => {
    if (normalizedName(current).includes('processenv')) found = true
  })
  return found
}

function containsCandidateReference(node) {
  let found = false
  if (!node) return found
  visitDescendants(node, current => {
    if (/candidate|locator|announcement|discovery/.test(normalizedName(current))) found = true
  })
  return found
}

function authorityTarget(name) {
  const relayKey = name.includes('relay') && (name.includes('key') || name.includes('mirror'))
  const trustedIndex = name.includes('index') && /trusted|default|authority/.test(name)
  const moderationAuthority = name.includes('moderation') && /trusted|default|authority|feed|key/.test(name)
  const trustRoot = /trustedroot|trustedsigner|defaultroot|defaultsigner/.test(name)
  const bootstrapAuthority = name.includes('bootstrap') && /trusted|default/.test(name) && /key|url|origin|endpoint/.test(name)
  return relayKey || trustedIndex || moderationAuthority || trustRoot || bootstrapAuthority
}

function trustRootTarget(name) {
  return /trusted|trustroot|authority|moderation/.test(name) || (name.includes('relay') && name.includes('key'))
}

function originTarget(name, filePath) {
  const contextual = `${filePath.replace(/[^a-z0-9]/gi, '').toLowerCase()}${name}`
  return /(?:upload|media).*(?:origin|endpoint|url)|(?:origin|endpoint|url).*(?:upload|media)/.test(contextual)
}

function targetInitializer(node) {
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
    return { name: normalizedName(node.name), expression: node.initializer }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return { name: normalizedName(node.left), expression: node.right }
  }
  return null
}

function bootstrapImportIsMediaCapability(moduleName) {
  return /(?:^|\/)(?:assets?|media|upload|transcode)(?:\/|$)|^(?:corestore|hyperblobs|hypercore|hypercore-blob-server)$/.test(moduleName)
}

function bootstrapCallCategory(callName) {
  const mediaNoun = 'media|asset|blob|rendition|core'
  const mediaVerb = 'open|serve|stream|send|fetch|read|get|replicate'
  if (new RegExp(`(?:${mediaVerb}).*(?:${mediaNoun})|(?:${mediaNoun}).*(?:${mediaVerb})`).test(callName)) return 'bootstrap-media-capability'
  if (/(?:trust|authorize|adopt|open).*(?:catalog|index|media|asset|blob|rendition|relay|mirror)|(?:catalog|index|media|asset|blob|rendition|relay|mirror).*(?:trust|authorize|adopt|open)/.test(callName)) return 'bootstrap-trust-escalation'
  if (/(?:trusted|authorized).*(?:add|set|push)|(?:add|set|push).*(?:trusted|authorized)/.test(callName)) return 'bootstrap-trust-escalation'
  return null
}

function inspectCentralization(files) {
  const violations = []
  const seen = new Set()

  function report(file, sourceFile, node, category, detail) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const message = `${file.path}:${line} ${category}: ${detail}`
    if (!seen.has(message)) {
      seen.add(message)
      violations.push(message)
    }
  }

  for (const file of files) {
    const sourceFile = parseSource(file)
    const bootstrapSource = /(?:^|\/)bootstrap[^/]*\.(?:cjs|js|mjs|ts|tsx)$/.test(file.path)

    visitDescendants(sourceFile, node => {
      const target = targetInitializer(node)
      if (target) {
        const literals = stringLiterals(target.expression)
        if (authorityTarget(target.name) && literals.some(value => keyLiteral.test(value) || remoteUrlLiteral.test(value))) {
          report(file, sourceFile, node, 'embedded-trust-authority', nodeName(node.name || node.left))
        }
        if (originTarget(target.name, file.path) && literals.some(value => remoteUrlLiteral.test(value))) {
          report(file, sourceFile, node, 'default-remote-origin', nodeName(node.name || node.left))
        }
        if (trustRootTarget(target.name) && containsDirectProcessEnv(target.expression)) {
          report(file, sourceFile, node, 'environment-only-trust-root', nodeName(node.name || node.left))
        }
        if (bootstrapSource && trustRootTarget(target.name) && containsCandidateReference(target.expression)) {
          report(file, sourceFile, node, 'bootstrap-trust-escalation', nodeName(node.name || node.left))
        }
      }

      if (!bootstrapSource) return
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && bootstrapImportIsMediaCapability(node.moduleSpecifier.text)) {
        report(file, sourceFile, node, 'bootstrap-media-capability', node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node)) {
        const callName = normalizedName(node.expression)
        const category = bootstrapCallCategory(callName)
        if (category) report(file, sourceFile, node, category, nodeName(node.expression))
      }
    })
  }

  return violations.sort()
}

function assertNoCentralization(t, files, message) {
  t.alike(inspectCentralization(files), [], message)
}

function baseLocator(keyPair, input = {}) {
  return {
    publisherId: 'a'.repeat(64),
    catalogBootstrapKey: 'b'.repeat(64),
    catalogHead: 'c'.repeat(64),
    catalogEpoch: 1,
    authorizationChainDigest: 'd'.repeat(64),
    issuedAt: 10_000,
    expiresAt: 20_000,
    keyPair,
    ...input,
  }
}

test('anti-centralization guard rejects structural policy defaults and accepts user runtime configuration', (t) => {
  const forbidden = readSourceFile(path.join(fixtureRoot, 'bootstrap-forbidden.mjs'))
  const allowed = readSourceFile(path.join(fixtureRoot, 'runtime-config.mjs'))
  const violations = inspectCentralization([forbidden])
  const triggers = (category, target) => violations.some(violation =>
    violation.includes(` ${category}:`) && violation.endsWith(target)
  )

  t.ok(triggers('embedded-trust-authority', 'trustedRelayKeys'), 'hardcoded relay key is rejected')
  t.ok(triggers('embedded-trust-authority', 'defaultTrustedIndexes'), 'default trusted index URL is rejected')
  t.ok(triggers('embedded-trust-authority', 'trustedModerationFeeds'), 'default moderation key is rejected')
  t.ok(triggers('default-remote-origin', 'defaultUploadOrigin'), 'default upload origin is rejected')
  t.ok(triggers('default-remote-origin', 'defaultMediaOrigin'), 'default media origin is rejected')
  t.ok(triggers('environment-only-trust-root', 'trustedRootIds'), 'env-only production trust root is rejected')
  t.ok(triggers('bootstrap-media-capability', 'mediaServer.serveMediaBytes'), 'bootstrap media serving is rejected')
  t.ok(triggers('bootstrap-trust-escalation', 'trustedCatalogs.add'), 'bootstrap trust escalation is rejected')
  assertNoCentralization(t, [allowed], 'user-supplied file/env runtime configuration is not a source default')
})

test('production source contains no implicit trust authority, media origin, or bootstrap escalation', (t) => {
  assertNoCentralization(t, productionSourceFiles(), 'production source stays permissionless')
})

test('bootstrap locators are metadata-only candidates and cannot trigger catalog/media authority', async (t) => {
  const signer = crypto.keyPair(Buffer.alloc(32, 41))
  const effects = []
  const manager = createBootstrapManager({
    now: () => 15_000,
    trustedSigners: [signer.publicKey],
    openCore: key => effects.push(['openCore', key]),
    openCatalog: key => effects.push(['openCatalog', key]),
    openMedia: key => effects.push(['openMedia', key]),
    serveMediaBytes: bytes => effects.push(['serveMediaBytes', bytes.length]),
    trustCatalog: key => effects.push(['trustCatalog', key]),
    trustMedia: key => effects.push(['trustMedia', key]),
  })
  const announced = createBootstrapLocator(baseLocator(signer, {
    mediaKey: 'e'.repeat(64),
    mediaBytes: Buffer.alloc(32, 7),
    uploadOrigin: 'https://upload.example.test',
  }))

  t.absent(announced.body.mediaKey, 'creator does not serialize a media key')
  t.absent(announced.body.mediaBytes, 'creator does not serialize media bytes')
  t.absent(announced.body.uploadOrigin, 'creator does not serialize an upload origin')
  t.is((await manager.ingestLocator('bootstrap-peer', announced.envelope)).status, 'accepted', 'signed locator is accepted as a candidate')
  const candidate = manager.getLocator('a'.repeat(64))
  t.is(candidate.catalogBootstrapKey, 'b'.repeat(64), 'bootstrap introduces a catalog candidate')
  t.absent(candidate.mediaKey, 'candidate cannot introduce media access')
  t.absent(candidate.uploadOrigin, 'candidate cannot introduce an origin')
  t.alike(effects, [], 'candidate ingestion does not open, serve, or trust anything')
})

test('bootstrap rejects media bytes hidden in extra locator metadata', async (t) => {
  const signer = crypto.keyPair(Buffer.alloc(32, 42))
  const embeddedMedia = [{ mediaBytes: 'x'.repeat(4096) }]

  t.exception(
    () => createBootstrapLocator(baseLocator(signer, { extraLocators: embeddedMedia })),
    /extra locator|metadata|bytes/i,
    'local creation rejects non-locator payload objects',
  )
  const validLocator = createBootstrapLocator(baseLocator(signer, { extraLocators: ['dht://peer.example.test'] }))
  t.alike(validLocator.body.extraLocators, ['dht://peer.example.test'], 'explicit string locator metadata remains supported')

  const body = {
    ...baseLocator(signer),
    version: 1,
    rootSignerId: null,
    label: null,
    extraLocators: embeddedMedia,
  }
  delete body.keyPair
  const envelope = createApplicationEnvelope({
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: signer,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  })
  t.absent(
    await verifyBootstrapLocator(envelope, { trustedSigners: [signer.publicKey], now: 15_000 }),
    'verification rejects signed non-metadata locator payloads from a trusted bootstrap signer',
  )
})
