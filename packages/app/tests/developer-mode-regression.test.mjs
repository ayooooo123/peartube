import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../node_modules/typescript/lib/typescript.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const app = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')

async function loadPreferenceStore() {
  const source = app('lib', 'developer-mode-storage.ts')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

async function loadGatePolicy() {
  const source = app('lib', 'developer-mode-gate.ts')
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  compiled = compiled.replace(/import \{ DEVELOPER_SETTINGS_PATH \} from ['"]\.\/developer-mode-routes['"];?/, "const DEVELOPER_SETTINGS_PATH = '/developer-settings';")
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

async function loadNativePreferenceStore(secureStore) {
  const source = app('lib', 'developer-mode-storage.native.ts')
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const slot = `__developerModeSecureStore${Math.random().toString(36).slice(2)}`
  globalThis[slot] = secureStore
  compiled = compiled.replace(/import \* as SecureStore from ['"]expo-secure-store['"];?/, `const SecureStore = globalThis.${slot};`)
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
  } finally {
    delete globalThis[slot]
  }
}

async function loadDeveloperModeState() {
  const source = app('lib', 'developer-mode-state.ts')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

async function loadArchiveParticipationModel() {
  const source = app('components', 'developer', 'archive-participation-model.ts')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

function memoryLocalStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
  }
}

test('Developer Mode persists through a web module reload and is never synchronized through RPC or network policy', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const localStorage = memoryLocalStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
  try {
    const first = await loadPreferenceStore()
    assert.equal(await first.readDeveloperModePreference(), false)
    await first.writeDeveloperModePreference(true)
    const reloaded = await loadPreferenceStore()
    assert.equal(await reloaded.readDeveloperModePreference(), true)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }

  const store = app('lib', 'developer-mode.ts')

  assert.match(store, /DEVELOPER_MODE_STORAGE_KEY/)
  assert.match(store, /read: readDeveloperModePreference/)
  assert.match(store, /write: writeDeveloperModePreference/)
  assert.doesNotMatch(store, /rpc\.|platformRPC|NetworkPolicy|pairing/i)
})

test('native Developer Mode preferences use a statically bundled local secure store adapter', () => {
  const nativeStore = app('lib', 'developer-mode-storage.native.ts')

  assert.match(nativeStore, /import \* as SecureStore from ['"]expo-secure-store['"]/)
  assert.match(nativeStore, /SecureStore\.getItemAsync\(DEVELOPER_MODE_STORAGE_KEY\)/)
  assert.match(nativeStore, /SecureStore\.setItemAsync\(DEVELOPER_MODE_STORAGE_KEY/)
  assert.doesNotMatch(nativeStore, /import\(['"]\.\/secure-storage['"]\)/)
  assert.doesNotMatch(nativeStore, /rpc\.|platformRPC|NetworkPolicy|pairing/i)
})

test('native Developer Mode preferences round-trip locally and surface native storage failures', async () => {
  const values = new Map()
  const secureStore = {
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value) },
  }
  const first = await loadNativePreferenceStore(secureStore)

  await first.writeDeveloperModePreference(true)
  const reloaded = await loadNativePreferenceStore(secureStore)
  assert.equal(await reloaded.readDeveloperModePreference(), true)

  const failing = await loadNativePreferenceStore({
    getItemAsync: async () => { throw new Error('native read failed') },
    setItemAsync: async () => { throw new Error('native write failed') },
  })
  await assert.rejects(() => failing.readDeveloperModePreference(), /native read failed/)
  await assert.rejects(() => failing.writeDeveloperModePreference(true), /native write failed/)
})

test('Developer Mode broadcasts its change only after the local preference write commits', async () => {
  const stateModule = await loadDeveloperModeState()
  const events = []
  let commit
  const state = stateModule.createDeveloperModeState({
    read: async () => false,
    write: async () => new Promise((resolve) => { commit = resolve }),
  })
  state.subscribe((enabled) => events.push(enabled))

  const pending = state.set(true)
  assert.deepEqual(events, [])
  commit()
  await pending
  assert.deepEqual(events, [true])

  const failedEvents = []
  const failingState = stateModule.createDeveloperModeState({
    read: async () => false,
    write: async () => { throw new Error('native write failed') },
  })
  failingState.subscribe((enabled) => failedEvents.push(enabled))
  await assert.rejects(() => failingState.set(true), /native write failed/)
  assert.deepEqual(failedEvents, [])
})

test('privileged routes resolve to Developer Settings while disabled and allow active mode', async () => {
  const routes = app('lib', 'developer-mode-routes.ts')
  const compiled = ts.transpileModule(routes, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const routePolicy = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
  assert.equal(routePolicy.developerModeDestination(false, '/studio'), '/developer-settings')
  assert.equal(routePolicy.developerModeDestination(false, '/profile?developer=diagnostics'), '/developer-settings')
  assert.equal(routePolicy.developerModeDestination(false, '/profile?developer=identity'), '/developer-settings')
  assert.equal(routePolicy.developerModeDestination(true, '/studio'), null)
  assert.equal(routePolicy.canShowIdentityTools(false), false)
  assert.equal(routePolicy.canShowIdentityTools(true), true)

  const gate = app('lib', 'developer-mode.ts')
  const privilegedRoutes = [
    ['app', '(tabs)', 'studio.tsx'],
    ['app', 'network-policy.tsx'],
    ['app', 'subscriptions.tsx'],
    ['app', 'moderation.tsx'],
    ['app', 'maintenance.tsx'],
    ['app', 'publisher-security.tsx'],
  ]

  assert.match(gate, /React\.createElement\(Redirect, \{ href: state\.href \}\)/)
  assert.match(gate, /useDeveloperMode\(\)/)
  for (const route of privilegedRoutes) {
    assert.match(app(...route), /DeveloperModeGate/)
  }
})

test('DeveloperModeGate redirects while disabled, renders while enabled, and redirects again when disabled in place', async () => {
  const gate = await loadGatePolicy()

  assert.deepEqual(gate.developerModeGateState({ enabled: false, isLoading: false }), { kind: 'redirect', href: '/developer-settings' })
  assert.deepEqual(gate.developerModeGateState({ enabled: true, isLoading: false }), { kind: 'content' })
  assert.deepEqual(gate.developerModeGateState({ enabled: false, isLoading: false }), { kind: 'redirect', href: '/developer-settings' })

  const component = app('lib', 'developer-mode.ts')
  assert.match(component, /developerModeGateState\(\{ enabled, isLoading \}\)/)
})

test('normal Profile hides identity tools and redirects a disabled diagnostics deep link', () => {
  const profile = app('app', 'profile.tsx')
  assert.match(profile, /developerModeDestination\(developerMode\.enabled, '\/profile\?developer=diagnostics'\)/)
  assert.match(profile, /developerMode\.enabled && \(/)
  assert.match(profile, /title="Developer Mode"/)
})

test('Developer Settings provides the complete operator surface only after local mode is enabled', () => {
  const screen = app('app', 'developer-settings.tsx')
  for (const label of [
    'Studio',
    'Publishing security',
    'Network policy',
    'Archive & maintenance',
    'Feed trust',
    'Moderation administration',
    'Identity tools',
    'Diagnostics',
  ]) {
    assert.match(screen, new RegExp(label))
  }
  assert.match(screen, /DeveloperModeGate/)
})

test('archive participation is confined to the Developer Settings operator surface', () => {
  const profile = app('app', 'profile.tsx')
  const screen = app('app', 'developer-settings.tsx')
  const archiveControl = app('components', 'developer', 'ArchiveParticipationControl.tsx')

  assert.doesNotMatch(profile, /Volunteer archive|ArchiveParticipation|archiveParticipation/)
  assert.match(screen, /ArchiveParticipationControl/)
  assert.match(archiveControl, /getArchiveParticipation/)
  assert.match(archiveControl, /setArchiveParticipation/)
  assert.match(archiveControl, /Volunteer archive/)
})

test('fresh archive participation capacity respects the local storage ceiling', async () => {
  const { archiveCapacityForStorageMax, GIB } = await loadArchiveParticipationModel()
  const archiveControl = app('components', 'developer', 'ArchiveParticipationControl.tsx')

  assert.equal(archiveCapacityForStorageMax(1 * GIB), 1 * GIB)
  assert.equal(archiveCapacityForStorageMax(20 * GIB), 5 * GIB)
  assert.match(archiveControl, /archiveCapacityForStorageMax\(storageMaxBytes\)/)
  assert.match(archiveControl, /maxRequestBytes: Math\.min\(status\?\.maxRequestBytes \|\| capacityBytes, capacityBytes\)/)
})

test('archive participation rejects stale loads and mutations after an RPC replacement or unmount', () => {
  const archiveControl = app('components', 'developer', 'ArchiveParticipationControl.tsx')

  assert.match(archiveControl, /useRef/)
  assert.match(archiveControl, /const generation = \+\+requestGeneration\.current/)
  assert.match(archiveControl, /generation !== requestGeneration\.current/)
  assert.match(archiveControl, /return \(\) => \{ requestGeneration\.current \+= 1 \}/)
})

test('Developer Mode toggle persistence failures stay local and visible in both entry points', () => {
  for (const source of [app('app', 'profile.tsx'), app('app', 'developer-settings.tsx')]) {
    assert.match(source, /const handleDeveloperModeChange = async/)
    assert.match(source, /await developerMode\.setEnabled\(enabled\)/)
    assert.match(source, /setDeveloperModeError\('Unable to update Developer Mode locally\. Please try again\.'\)/)
    assert.match(source, /accessibilityRole="alert"/)
    assert.doesNotMatch(source, /void developerMode\.setEnabled/)
  }
})

test('Publishing Security uses native-safe React Native hosts', () => {
  const route = app('app', 'publisher-security.tsx')
  assert.match(route, /import \{[^}]*Text[^}]*View[^}]*\} from 'react-native'/)
  assert.match(route, /<View/)
  assert.match(route, /<PublisherDeviceStatus/)
  assert.match(route, /useEffect\(\(\) => \{\s+let active = true\s+setStatus\(initialStatus \?\? null\)/)
  assert.doesNotMatch(route, /<main>|<section/)
})
