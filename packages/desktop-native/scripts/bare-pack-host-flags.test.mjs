import fs from 'fs'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

const packageRoot = path.resolve(import.meta.dirname, '..')

const barePackScriptPaths = [
  'scripts/ensure-barekit-echo-bundle.mjs',
  'scripts/ensure-barekit-bare-fs-bundle.mjs',
  'scripts/ensure-barekit-corestore-bundle.mjs',
  'scripts/ensure-host-sidecar-bundle.mjs',
  'scripts/ensure-host-worklet-bundle.mjs',
]

const bareLinkScriptPaths = [
  'scripts/ensure-host-sidecar-frameworks.mjs',
]

test('desktop-native bare-pack scripts use --host instead of removed --target flag', () => {
  for (const relativePath of barePackScriptPaths) {
    const absolutePath = path.join(packageRoot, relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')

    assert.doesNotMatch(
      source,
      /--target\b/,
      `${relativePath} should not pass the removed bare-pack --target flag`
    )
    assert.match(
      source,
      /--host\b/,
      `${relativePath} should pass bare-pack --host`
    )
  }
})

test('desktop-native bare-link scripts use --host instead of removed --target flag', () => {
  for (const relativePath of bareLinkScriptPaths) {
    const absolutePath = path.join(packageRoot, relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')

    assert.doesNotMatch(
      source,
      /--target\b/,
      `${relativePath} should not pass the removed bare-link --target flag`
    )
    assert.match(
      source,
      /--host\b/,
      `${relativePath} should pass bare-link --host`
    )
  }
})

test('native host worklet bundler falls back to app node_modules for workspace package links', () => {
  const absolutePath = path.join(packageRoot, 'scripts/ensure-host-worklet-bundle.mjs')
  const source = fs.readFileSync(absolutePath, 'utf8')

  assert.match(
    source,
    /packages', 'app', 'node_modules'/,
    'ensure-host-worklet-bundle should use packages/app/node_modules as a workspace fallback',
  )
  assert.match(
    source,
    /linkPackageNodeModules/,
    'ensure-host-worklet-bundle should link package-local node_modules into the temp bundle tree',
  )
  assert.match(
    source,
    /const fallbackSourcePath = appNodeModulesPath/,
    'ensure-host-worklet-bundle should define an app node_modules fallback source',
  )
  assert.match(
    source,
    /fs\.existsSync\(fallbackSourcePath\)/,
    'ensure-host-worklet-bundle should use the app node_modules fallback when a package-local directory is missing',
  )
})

test('native host sidecar bundler stages a temp bundle tree with app node_modules fallback', () => {
  const absolutePath = path.join(packageRoot, 'scripts/ensure-host-sidecar-bundle.mjs')
  const source = fs.readFileSync(absolutePath, 'utf8')

  assert.match(
    source,
    /packages', 'app', 'node_modules'/,
    'ensure-host-sidecar-bundle should use packages/app/node_modules as a workspace fallback',
  )
  assert.match(
    source,
    /function findNodeModulesRoot\(/,
    'ensure-host-sidecar-bundle should resolve a node_modules root for temp bundling',
  )
  assert.match(
    source,
    /function linkPackageNodeModules\(/,
    'ensure-host-sidecar-bundle should link package-local node_modules into the temp bundle tree',
  )
  assert.match(
    source,
    /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'peartube-native-sidecar-'\)\)/,
    'ensure-host-sidecar-bundle should stage a temporary bundle root',
  )
})

test('native host sidecar bundler regenerates missing or stale HRPC spec before staging temp tree', () => {
  const absolutePath = path.join(packageRoot, 'scripts/ensure-host-sidecar-bundle.mjs')
  const source = fs.readFileSync(absolutePath, 'utf8')

  assert.match(
    source,
    /function ensureGeneratedSpec\(/,
    'ensure-host-sidecar-bundle should explicitly guard generated spec outputs',
  )
  assert.match(
    source,
    /path\.join\(specRoot, 'spec', 'hrpc', 'index\.js'\)/,
    'ensure-host-sidecar-bundle should require generated HRPC entry before bare-pack traversal',
  )
  assert.match(
    source,
    /path\.join\(specRoot, 'schema\.cjs'\)/,
    'ensure-host-sidecar-bundle should use the canonical schema generator as an invalidation input',
  )
  assert.match(
    source,
    /walkNewestMtimeMs\(path\.join\(specRoot, 'lib'\)\)/,
    'ensure-host-sidecar-bundle should invalidate generated HRPC when schema generator helpers change',
  )
  assert.match(
    source,
    /generatedMtime > 0 && generatedMtime >= generatorNewest/,
    'ensure-host-sidecar-bundle should not treat existing generated files as current when schema inputs are newer',
  )
  assert.match(
    source,
    /spawnSync\(process\.execPath, \[schemaScript\]/,
    'ensure-host-sidecar-bundle should invoke schema.cjs with the current Node runtime',
  )
  assert.match(
    source,
    /ensureGeneratedSpec\(\)\s*\n\s*for \(const sourcePath of sourceRoots\)/,
    'ensure-host-sidecar-bundle should generate spec before staging sourceRoots into the temp bundle root',
  )
})

test('native host sidecar keeps backend handlers behind backend package boundary', () => {
  const sidecarSource = fs.readFileSync(path.join(packageRoot, 'Bridge', 'native-host-sidecar.mjs'), 'utf8')
  const sidecarBundleSource = fs.readFileSync(path.join(packageRoot, 'scripts', 'ensure-host-sidecar-bundle.mjs'), 'utf8')
  const workletBundleSource = fs.readFileSync(path.join(packageRoot, 'scripts', 'ensure-host-worklet-bundle.mjs'), 'utf8')

  assert.doesNotMatch(sidecarSource, /\.\.\/\.\.\/app\/backend\//)
  assert.match(sidecarSource, /\.\.\/\.\.\/backend\/src\/mobile-handlers\.js/)
  assert.match(sidecarSource, /\.\.\/\.\.\/backend\/src\/transcode\/transcoder\.mjs/)
  assert.doesNotMatch(sidecarBundleSource, /packages', 'app', 'backend'/)
  assert.doesNotMatch(workletBundleSource, /packages', 'app', 'backend'/)
})

test('native host sidecar rejects missing backend protocol versions instead of defaulting to supported version', () => {
  const sidecarSource = fs.readFileSync(path.join(packageRoot, 'Bridge', 'native-host-sidecar.mjs'), 'utf8')
  const workletPushSource = fs.readFileSync(path.join(packageRoot, 'Bridge', 'native-host-worklet-push.mjs'), 'utf8')

  assert.doesNotMatch(sidecarSource, /protocolVersion:\s*ready\?\.protocolVersion\s*\?\?\s*2/)
  assert.doesNotMatch(workletPushSource, /protocolVersion:\s*ready\?\.protocolVersion\s*\?\?\s*2/)
  assert.match(sidecarSource, /Host ready payload missing protocolVersion/)
  assert.match(workletPushSource, /Host ready payload missing protocolVersion/)
})

test('desktop release workflow generates HRPC schema before desktop release builds', () => {
  const workflowPath = path.resolve(packageRoot, '..', '..', '.github', 'workflows', 'release-desktop.yml')
  const source = fs.readFileSync(workflowPath, 'utf8')
  const electrobunSchemaIndex = source.indexOf('Generate HRPC schema')
  const electrobunBuildIndex = source.indexOf('Build desktop app')
  const nativeSchemaIndex = source.indexOf('Generate HRPC schema', electrobunBuildIndex)
  const nativeProjectIndex = source.indexOf('Generate native desktop project')

  assert.ok(electrobunSchemaIndex >= 0, 'electrobun release job should generate HRPC schema')
  assert.ok(electrobunSchemaIndex < electrobunBuildIndex, 'electrobun release schema generation should run before web bundling')
  assert.ok(nativeSchemaIndex >= 0, 'native desktop release job should generate full HRPC/Swift schema')
  assert.ok(nativeSchemaIndex < nativeProjectIndex, 'native release schema generation should run before native project generation')
})


test('Swift supported protocol version is generated from host protocol version', async () => {
  const { PROTOCOL_VERSION } = await import('../../host/src/contracts.js')
  const generatedSource = fs.readFileSync(path.join(packageRoot, 'Sources', 'Support', 'ProtocolVersion.swift'), 'utf8')
  const serviceSource = fs.readFileSync(path.join(packageRoot, 'Sources', 'Services', 'HostBridgeService.swift'), 'utf8')
  assert.match(generatedSource, new RegExp(`NativeHostProtocolVersion = ${PROTOCOL_VERSION}\\b`))
  assert.match(serviceSource, /supportedProtocolVersion = NativeHostProtocolVersion/)
})
