/**
 * Balanced participation is a resource policy, not a promise.
 *
 * A viewer sees one choice — Data Saver / Balanced / Help More — described in
 * terms of what the device actually does. Everything numeric stays in Developer
 * Settings, and the live contribution state comes from the backend so the screen
 * can never announce a contribution the resource policy has suspended.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), 'utf8')

const profile = read('app/profile.tsx')
const developerNetworkPolicy = read('app/network-policy.tsx')
const model = await import(pathToFileURL(path.join(appRoot, 'lib/network-policy.ts')).href)

/**
 * The reason codes are the backend's, not a list this package maintains. Import
 * the canonical order straight from the resource policy so a code added there
 * fails here until a viewer sentence exists for it.
 */
const backendPolicy = await import(pathToFileURL(path.join(appRoot, '../backend/src/playback/resource-policy.js')).href)

async function loadProfileCards() {
  const participationStart = profile.indexOf('function ParticipationCard')
  const storageStart = profile.indexOf('function StorageCard')
  const nextComponent = profile.indexOf('function ProfileDiagnosticsCard', storageStart)
  assert.ok(participationStart >= 0 && storageStart > participationStart && nextComponent > storageStart)

  const source = [
    `import { PARTICIPATION_MODE_OPTIONS, PARTICIPATION_STATE_COPY, PARTICIPATION_UNAVAILABLE_COPY, participationReasonCopy } from './lib/network-policy'`,
    'const host = tag => ({ children }) => React.createElement(tag, null, children)',
    'const View = host("div")',
    'const Text = host("span")',
    'const GlassCard = host("section")',
    'const SectionHeader = ({ title, subtitle }) => React.createElement("header", null, React.createElement("h2", null, title), React.createElement("p", null, subtitle))',
    'const Feather = () => null',
    'const StorageOperabilityDetails = () => null',
    'const TextInput = props => React.createElement("input", { "data-keyboard-type": props.keyboardType, value: props.value })',
    'const Pressable = props => { globalThis.__peartubePressables.push(props.onPress); return React.createElement("button", null, props.children) }',
    'const colors = { text: "text", textMuted: "muted", swarm: "swarm", success: "success", warning: "warning", onPrimary: "on-primary" }',
    'const styles = new Proxy({}, { get: () => null })',
    'const React = globalThis.__peartubeReact',
    profile.slice(participationStart, nextComponent),
    'export { ParticipationCard, StorageCard }',
  ].join('\n')

  const result = await build({
    stdin: {
      contents: source,
      resolveDir: appRoot,
      sourcefile: 'profile-card-runtime.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    external: ['react'],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.profile-card-'))
  const output = path.join(directory, 'cards.mjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  globalThis.__peartubeReact = React
  globalThis.__peartubePressables = []
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}


test('normal preferences offer the three participation modes and say what each one does', async () => {
  assert.deepEqual(
    model.PARTICIPATION_MODE_OPTIONS.map((option) => option.value),
    ['data-saver', 'balanced', 'help-more'],
    'the viewer sees exactly the three backend modes, in escalating order',
  )
  assert.equal(model.DEFAULT_NETWORK_POLICY.participationMode, 'balanced', 'a fresh install is Balanced')

  const detail = Object.fromEntries(model.PARTICIPATION_MODE_OPTIONS.map((option) => [option.value, option.detail]))

  // Data Saver: playback only. No grace window, no background work.
  assert.match(detail['data-saver'], /only while you are watching/i)
  assert.match(detail['data-saver'], /nothing runs in the background/i)

  // Balanced: playback plus the grace window, and opportunistic background.
  assert.match(detail.balanced, /while you watch and for a short while after/i)
  assert.match(detail.balanced, /background/i)
  assert.match(detail.balanced, /unmetered/i)

  // Help More: wider user ceilings, and no authority over the device or the OS.
  assert.match(detail['help-more'], /raises your own upload and cache limits/i)
  assert.match(detail['help-more'], /cannot override your device or operating system/i)

  const cards = await loadProfileCards()
  globalThis.__peartubePressables.length = 0
  const selected = []
  const markup = renderToStaticMarkup(React.createElement(cards.ParticipationCard, {
    networkPolicy: { policy: { participationMode: 'balanced' } },
    participation: { status: null, loading: false, error: null },
    participationSaving: false,
    onModeChange: (mode) => selected.push(mode),
  }))
  for (const option of model.PARTICIPATION_MODE_OPTIONS) {
    assert.match(markup, new RegExp(option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(markup, new RegExp(option.detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const onPress of globalThis.__peartubePressables) onPress()
  assert.deepEqual(
    selected,
    model.PARTICIPATION_MODE_OPTIONS.map((option) => option.value),
    'each rendered mode invokes the real card callback with its backend value',
  )
  assert.match(profile, /networkPolicy\.update\(\{ participationMode \}\)/)
})

test('participation copy never states a ceiling the backend enforces elsewhere', () => {
  const consumerCopy = [
    ...model.PARTICIPATION_MODE_OPTIONS.map((option) => `${option.label} ${option.detail}`),
    ...Object.values(model.PARTICIPATION_STATE_COPY).map((state) => `${state.label} ${state.detail}`),
    ...Object.values(model.PARTICIPATION_REASON_COPY),
  ].join('\n')

  assert.doesNotMatch(consumerCopy, /\d+\s*(GB|GiB|MB|MiB|TB|bytes?|Mbit|Mbps|kbps)/i, 'no byte or rate figure in viewer copy')
  assert.doesNotMatch(consumerCopy, /\b\d+\s*(minutes?|hours?)\b/i, 'no duration figure in viewer copy')
  assert.doesNotMatch(consumerCopy, /\b\d+\s*%/, 'no battery or disk percentage in viewer copy')
})

test('exact ceilings and archive controls stay out of normal preferences', async () => {
  const cards = await loadProfileCards()
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

  const normal = renderToStaticMarkup(React.createElement(cards.StorageCard, {
    ...props,
    developerModeEnabled: false,
  }))
  assert.match(normal, /4\.0 GB total/)
  assert.match(normal, /1\.0 GB cached/)
  assert.match(normal, /app\/P2P data outside tracked peer cache/)
  assert.doesNotMatch(normal, /Cache budget override/)
  assert.doesNotMatch(normal, /data-keyboard-type="numeric"/)

  const developer = renderToStaticMarkup(React.createElement(cards.StorageCard, {
    ...props,
    developerModeEnabled: true,
  }))
  assert.match(developer, /Cache budget override/)
  assert.match(developer, /data-keyboard-type="numeric"/)

  // The Light/Balanced/Generous buttons wrote the same seeding budget the mode
  // now owns, so the storage card defers to the mode instead of competing.
  assert.doesNotMatch(profile, /SUPPORT_PRESETS|styles\.preset/, 'the competing cache presets are gone')
  assert.match(profile, /Your sharing choice above sets this budget/, 'the storage card points at the one control')

  // Archive pledges are opt-in operator work and are never offered here.
  assert.doesNotMatch(profile, /archive-pledges|retentionMode|setArchiveParticipation/, 'archive controls stay in Developer Settings')
  assert.match(developerNetworkPolicy, /DeveloperModeGate/)
  assert.match(read('components/library/RetentionPolicyEditor.tsx'), /Archive participation/)

  // Exact byte editing lives on the gated policy screen.
  assert.match(developerNetworkPolicy, /RetentionPolicyEditor/)
  assert.match(developerNetworkPolicy, /PARTICIPATION_MODE_LABELS/, 'the operator screen names the mode it is overriding')
})

test('the live contribution state comes from the backend, not from a local computation', () => {
  assert.match(profile, /useParticipationStatus\(rpc\)/, 'the screen subscribes to the backend status')
  assert.match(profile, /participation\.status/)
  assert.match(profile, /PARTICIPATION_STATE_COPY\[status\.state\]/, 'the label is chosen by the reported state')
  assert.match(profile, /participationReasonCopy\(code\)/, 'reasons are the backend reason codes, rendered')

  // No local gate evaluation may leak into the consumer screen.
  for (const localGate of [
    /batteryPercent/,
    /thermalState/,
    /freeDiskBytes/,
    /uploadedBytesLast24h\s*[<>]/,
    /evaluateParticipation/,
  ]) {
    assert.doesNotMatch(profile, localGate, `the app must not re-derive eligibility: ${localGate}`)
  }

  const hook = read('hooks/useNetworkPolicy.ts')
  assert.match(hook, /loadParticipationStatus\(rpc\)/)
  assert.match(hook, /setStatus\(null\)/, 'a failed read drops the status instead of leaving a stale claim')
})

test('a suspended device is never described as contributing, and nothing promises an SLA', () => {
  const suspended = model.PARTICIPATION_STATE_COPY.suspended
  assert.equal(suspended.label, 'Suspended')
  assert.match(suspended.detail, /not contributing/i)
  assert.doesNotMatch(`${suspended.label} ${suspended.detail}`, /uploading|serving|helping|contributing to/i)

  // "Eligible" is permission, not activity.
  const eligible = model.PARTICIPATION_STATE_COPY.eligible
  assert.match(eligible.detail, /Nothing is being uploaded at this moment/i)

  // Only the reported state may drive the label, so the three are distinct.
  const labels = Object.values(model.PARTICIPATION_STATE_COPY).map((state) => state.label)
  assert.equal(new Set(labels).size, 3)

  const allCopy = [
    profile,
    ...Object.values(model.PARTICIPATION_STATE_COPY).map((state) => state.detail),
    ...Object.values(model.PARTICIPATION_REASON_COPY),
    ...model.PARTICIPATION_MODE_OPTIONS.map((option) => option.detail),
  ].join('\n')
  assert.doesNotMatch(
    allCopy,
    /guarantee|guaranteed|always available|stays online forever|uptime|99\.9|service level|24\/7/i,
    'no availability promise anywhere on the participation surface',
  )
  assert.match(profile, /nothing here\s*\n?\s*promises a video stays online/i, 'the screen says helping is best effort')
})

test('reason codes render in viewer language and unknown codes stay honest', () => {
  // Set equality, not a count: a code the backend added and this map never
  // learned would render as "a limit this version does not recognise", and a
  // sentence for a code the backend cannot emit is dead copy nobody maintains.
  const backendCodes = new Set(backendPolicy.PARTICIPATION_REASON_CODES)
  const copiedCodes = new Set(Object.keys(model.PARTICIPATION_REASON_COPY))
  assert.deepEqual(copiedCodes, backendCodes, 'every backend reason code has viewer copy, and nothing else does')
  assert.equal(model.MAX_PARTICIPATION_REASON_CODES, backendPolicy.MAX_PARTICIPATION_REASON_CODES)

  for (const code of backendCodes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, 'codes are the backend literals')
    const copy = model.participationReasonCopy(code)
    assert.equal(copy, model.PARTICIPATION_REASON_COPY[code])
    assert.doesNotMatch(copy, /[A-Z]{2,}_[A-Z]/, 'no raw code leaks into the sentence')
  }

  // An unrecognised mode falls back to the backend's most constrained mode, not
  // to the fresh-install one, so this sentence may not name a mode at all.
  assert.equal(backendPolicy.PARTICIPATION_LIMITS['data-saver'].backgroundSessionMs, 0, 'data-saver is still the most constrained mode')
  for (const label of Object.values(model.PARTICIPATION_MODE_LABELS)) {
    assert.doesNotMatch(
      model.PARTICIPATION_REASON_COPY.MODE_UNRECOGNIZED,
      new RegExp(label, 'i'),
      'an unrecognised saved mode must not be reported as any named mode',
    )
  }

  // An unknown OS signal is a constraint, not a fault or a promise — but it
  // constrains only the opportunistic background work, because the acceptance
  // names those five requirements for background work and promises upload
  // during playback and its grace window outright. So these lines are routinely
  // rendered beside "Actively uploading" and may not contradict it.
  for (const code of ['NETWORK_SIGNAL_UNKNOWN', 'THERMAL_SIGNAL_UNKNOWN', 'POWER_SIGNAL_UNKNOWN', 'DISK_SIGNAL_UNKNOWN']) {
    const copy = model.PARTICIPATION_REASON_COPY[code]
    assert.match(copy, /cannot (tell|read)/i, `${code} says the device could not read the signal`)
    assert.match(copy, /background/i, `${code} must name background sharing as the thing that is off`)
    assert.doesNotMatch(
      copy,
      /\bwaits\b|\bpaused\b|nothing is (uploaded|shared)|not contributing/i,
      `${code} must not claim this device stopped contributing: it may be uploading right now`,
    )
  }

  // A signal the device did read, and that came back bad, still stops everything.
  assert.match(model.PARTICIPATION_REASON_COPY.NETWORK_METERED, /nothing is uploaded/i)
  assert.match(model.PARTICIPATION_REASON_COPY.THERMAL_PRESSURE, /paused/i)

  const unknown = model.participationReasonCopy('SOMETHING_NEWER_THAN_THIS_BUILD')
  assert.match(unknown, /does not recognise/i)
  assert.doesNotMatch(unknown, /SOMETHING_NEWER/)
})

test('participation status is decoded from the wire and refuses to invent a state', () => {
  const wire = {
    success: true,
    mode: 'balanced',
    state: 'uploading',
    uploadEligible: true,
    uploading: true,
    backgroundEligible: false,
    cacheCeilingBytes: 21474836480,
    uploadCeilingBytesPer24h: 1073741824,
    uploadedBytesLast24h: 12345,
    outboundBytesPerSecond: 625000,
    postPlaybackGraceMs: 600000,
    backgroundRemainingSessionMs: 900000,
    backgroundRemainingDailyMs: 3600000,
    reasonCodes: [],
  }
  const status = model.normalizeParticipationStatus(wire)
  assert.equal(status.state, 'uploading')
  assert.equal(status.cacheCeilingBytes, 21474836480)
  assert.deepEqual(status.reasonCodes, [])
  assert.equal(status.errorCode, null)

  // A failed envelope may only ever arrive as a suspension. The backend sends a
  // complete suspended decision on failure, so it renders as "suspended, and
  // here is why" rather than a blank status — but it can never carry an
  // eligibility or upload claim, and a failed envelope in any other state is
  // refused outright.
  const unavailable = model.normalizeParticipationStatus({
    ...wire,
    success: false,
    errorCode: 'PARTICIPATION_UNAVAILABLE',
    state: 'suspended',
    uploadEligible: true,
    uploading: true,
    reasonCodes: ['NETWORK_SIGNAL_UNKNOWN'],
  })
  assert.equal(unavailable.state, 'suspended')
  assert.equal(unavailable.errorCode, 'PARTICIPATION_UNAVAILABLE')
  assert.equal(unavailable.uploadEligible, false, 'a failed read never carries an eligibility claim')
  assert.equal(unavailable.uploading, false, 'a failed read never carries an upload claim')
  assert.match(model.PARTICIPATION_UNAVAILABLE_COPY, /contributing nothing/i)

  assert.throws(() => model.normalizeParticipationStatus({ ...wire, success: false, errorCode: 'PARTICIPATION_UNAVAILABLE' }), /PARTICIPATION_UNAVAILABLE/)
  assert.throws(() => model.normalizeParticipationStatus({ ...wire, state: 'helping' }), /participation state/)
  assert.throws(() => model.normalizeParticipationStatus({ ...wire, state: undefined }), /participation state/)
  assert.throws(() => model.normalizeParticipationStatus({ ...wire, cacheCeilingBytes: -1 }), /cache ceiling/)

  // Reason codes are bounded and deduplicated exactly like the backend's list.
  const flooded = model.normalizeParticipationStatus({
    ...wire,
    state: 'suspended',
    reasonCodes: ['NETWORK_METERED', 'NETWORK_METERED', ...Array.from({ length: 20 }, (_, index) => `CODE_${index}`)],
  })
  assert.equal(flooded.reasonCodes.length, model.MAX_PARTICIPATION_REASON_CODES)
  assert.equal(flooded.reasonCodes[0], 'NETWORK_METERED')
  assert.equal(new Set(flooded.reasonCodes).size, flooded.reasonCodes.length)
})
