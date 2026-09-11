import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
// The settings tab is now a redirect to the Profile screen, which owns the
// StorageCard component. Assert the storage UI lives there.
const profileSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'profile.tsx'), 'utf8')

async function loadStorageCard() {
  const start = profileSource.indexOf('function StorageCard')
  const end = profileSource.indexOf('function ProfileDiagnosticsCard', start)
  assert.ok(start >= 0 && end > start, 'StorageCard component should exist')
  const result = await build({
    stdin: {
      contents: [
        'const React = globalThis.__storageReact',
        'const host = tag => ({ children }) => React.createElement(tag, null, children)',
        'const View = host("div")',
        'const Text = host("span")',
        'const Panel = host("section")',
        'const Feather = () => null',
        'const StorageOperabilityDetails = () => null',
        'const TextInput = props => React.createElement("input", { "data-keyboard-type": props.keyboardType, value: props.value })',
        'const Pressable = props => { globalThis.__storagePressables.push(props.onPress); return React.createElement("button", null, props.children) }',
        'const colors = { text: "text", textMuted: "muted", swarm: "swarm", onPrimary: "on-primary" }',
        'const styles = new Proxy({}, { get: () => null })',
        profileSource.slice(start, end),
        'export { StorageCard }',
      ].join('\n'),
      resolveDir: path.join(__dirname, '..'),
      sourcefile: 'storage-card-runtime.tsx',
      loader: 'tsx',
    },
    bundle: false,
    write: false,
    format: 'esm',
    platform: 'node',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  })
  const directory = fs.mkdtempSync(path.join(__dirname, '.storage-card-'))
  const output = path.join(directory, 'storage-card.mjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  globalThis.__storageReact = React
  globalThis.__storagePressables = []
  try {
    return (await import(`${new URL(output, 'file:').href}?${Math.random()}`)).StorageCard
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('profile storage card surfaces real disk usage and gates the exact cache limit', async () => {
  const StorageCard = await loadStorageCard()
  const storageStats = {
    usedBytes: 1,
    maxBytes: 5,
    usedGB: '1.0',
    maxGB: 5,
    seedCount: 1,
    pinnedCount: 0,
    totalStorageGB: '4.0',
    untrackedStorageBytes: 3,
    untrackedStorageGB: '3.0',
  }
  const props = {
    storageStats,
    storageLimitPreview: null,
    usedPct: 20,
    customStorageLimit: '5',
    storageLimitSaving: false,
    clearingCache: false,
    onCustomLimitChange() {},
    onCustomLimitApply() {},
    onClearCache() {},
  }

  const normal = renderToStaticMarkup(React.createElement(StorageCard, {
    ...props,
    developerModeEnabled: false,
  }))
  assert.match(normal, /4\.0 GB total/)
  assert.match(normal, /1\.0 GB cached/)
  assert.match(normal, /app\/P2P data outside tracked peer cache/)
  assert.match(normal, /Your sharing choice above sets this budget/)
  assert.match(normal, /Clear cached videos/)
  assert.doesNotMatch(normal, /Cache budget override/)
  assert.doesNotMatch(normal, /data-keyboard-type="numeric"/)

  const developer = renderToStaticMarkup(React.createElement(StorageCard, {
    ...props,
    developerModeEnabled: true,
  }))
  assert.match(developer, /Cache budget override/)
  assert.match(developer, /data-keyboard-type="numeric"/)
})
