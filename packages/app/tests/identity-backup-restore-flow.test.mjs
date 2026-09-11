import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const profilePath = new URL('../app/profile.tsx', import.meta.url)


async function loadProfileBodies() {
  const src = await source()
  const recoveryStart = src.indexOf('function RecoveryPhraseCard')
  const restoreStart = src.indexOf('function RestoreCard')
  const onboardingStart = src.indexOf('function ProfileOnboardingBody')
  const identityStart = src.indexOf('function ProfileIdentityBody')
  const bodyEnd = src.indexOf('async function runPersonalDeviceUnlink', identityStart)
  assert.ok(recoveryStart >= 0 && restoreStart > recoveryStart && onboardingStart > restoreStart && identityStart > onboardingStart && bodyEnd > identityStart)

  const instrumented = [
    'const React = globalThis.__identityReact',
    'const host = tag => ({ children }) => React.createElement(tag, null, children)',
    'const View = host("div")',
    'const Text = host("span")',
    'const GlassCard = host("section")',
    'const SectionHeader = ({ title, subtitle }) => React.createElement("header", null, React.createElement("h2", null, title), React.createElement("p", null, subtitle))',
    'const ActivityIndicator = () => null',
    'const Feather = () => null',
    'const TextInput = props => React.createElement("input", { placeholder: props.placeholder, value: props.value })',
    'const Pressable = props => { globalThis.__identityPressables.push(props); return React.createElement("button", null, props.children) }',
    'const colors = { text: "text", textMuted: "muted", onPrimary: "on-primary" }',
    'const styles = new Proxy({}, { get: () => null })',
    src.slice(recoveryStart, onboardingStart),
    src.slice(onboardingStart, identityStart),
    src.slice(identityStart, bodyEnd),
    'export { RecoveryPhraseCard, RestoreCard, ProfileOnboardingBody, ProfileIdentityBody }',
  ].join('\n')

  const result = await build({
    stdin: {
      contents: instrumented,
      sourcefile: 'profile-recovery-runtime.tsx',
      loader: 'tsx',
    },
    bundle: false,
    write: false,
    format: 'esm',
    platform: 'node',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  })
  const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/peartube-profile-'))
  const output = `${directory}/profile-bodies.mjs`
  await import('node:fs/promises').then(({ writeFile }) => writeFile(output, result.outputFiles[0].text))
  globalThis.__identityReact = React
  globalThis.__identityPressables = []
  try {
    return await import(`${new URL(`file://${output}`).href}?${Math.random()}`)
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }))
  }
}
async function source() {
  return readFile(profilePath, 'utf8')
}

test('channel creation surfaces the one-time recovery phrase instead of discarding it', async () => {
  const src = await source()

  // The backend derives the mnemonic at creation and never persists it —
  // before this flow existed the app threw the phrase away, so users could
  // never back up their channel.
  assert.match(src, /newIdentity\?\.seedPhrase/, 'creation handler must read the seedPhrase from the createIdentity response')
  assert.match(src, /setRecoveryPhrase\(phrase\.trim\(\)\)/, 'the phrase must be staged for one-time display')
  assert.match(src, /confirmRecoveryPhraseSaved/, 'dismissing the phrase requires explicit confirmation')
  assert.match(src, /setRecoveryPhrase\(null\)/, 'confirmation clears the phrase from memory')
  const bodies = await loadProfileBodies()
  let copied = 0
  let confirmed = 0
  const phraseMarkup = renderToStaticMarkup(React.createElement(bodies.RecoveryPhraseCard, {
    recoveryPhrase: 'alpha beta gamma',
    onCopy: () => { copied += 1 },
    onConfirmSaved: () => { confirmed += 1 },
  }))
  assert.match(phraseMarkup, /Recovery phrase/)
  assert.match(phraseMarkup, /alpha beta gamma/)
  assert.match(phraseMarkup, /I’ve saved my phrase|I&#x27;ve saved my phrase/)
  for (const props of globalThis.__identityPressables) props.onPress?.()
  assert.equal(copied, 1)
  assert.equal(confirmed, 1)

  const handlerStart = src.indexOf('const handleCreateIdentity')
  const handler = src.slice(handlerStart, src.indexOf('const promptPublishNewChannel'))
  assert.match(handler, /if \(typeof phrase === 'string' && phrase\.trim\(\)\.length > 0\) \{[\s\S]*?return/, 'the publish prompt must wait until the user confirms the phrase is saved')
})

test('restore flow recovers, activates, and reloads the identity', async () => {
  const src = await source()

  const restoreStart = src.indexOf('const handleRestoreIdentity')
  assert.notEqual(restoreStart, -1, 'expected a restore handler')
  const restore = src.slice(restoreStart, src.indexOf('const togglePublish'))

  assert.match(restore, /wordCount !== 12 && wordCount !== 24/, 'phrase length is validated before hitting the backend')
  assert.match(restore, /recoverIdentity\(\{ seedPhrase: phrase \}\)/, 'restore calls the recoverIdentity RPC')
  // identity.js recoverIdentity registers the identity with isActive: false —
  // the UI must activate it or the restored channel never becomes current.
  assert.match(restore, /setActiveIdentity\(\{ publicKey: recovered\.publicKey \}\)/, 'restored identity must be activated')
  assert.match(restore, /await loadIdentity\(\)/, 'app identity state must be refreshed after restore')
  assert.match(restore, /[Rr]estart the app/, 'user is told a restart finishes applying the recovery key')
})

test('restore is reachable from onboarding and from the authenticated profile', async () => {
  const bodies = await loadProfileBodies()
  const bodyProps = {
    restorePhrase: 'alpha beta gamma',
    restoring: false,
    onPhraseChange() {},
    onRestore() {},
    sharedCards: null,
  }

  const onboarding = renderToStaticMarkup(React.createElement(bodies.ProfileOnboardingBody, {
    ...bodyProps,
    showIdentityTools: true,
    newName: 'Channel',
    creating: false,
    onNameChange() {},
    onCreateIdentity() {},
  }))
  assert.match(onboarding, /Restore a channel/)
  assert.match(onboarding, /Enter your 12-word recovery phrase/)

  const onboardingHidden = renderToStaticMarkup(React.createElement(bodies.ProfileOnboardingBody, {
    ...bodyProps,
    showIdentityTools: false,
    newName: '',
    creating: false,
    onNameChange() {},
    onCreateIdentity() {},
  }))
  assert.doesNotMatch(onboardingHidden, /Restore a channel/)

  const authenticated = renderToStaticMarkup(React.createElement(bodies.ProfileIdentityBody, {
    ...bodyProps,
    showIdentityTools: true,
    recoveryPhrase: null,
    onCopyPhrase() {},
    onConfirmPhraseSaved() {},
    identityName: 'Channel',
    onShareChannel() {},
    onCopyKey() {},
    restoreOpen: false,
    onOpenRestore() {},
    developerModeEnabled: false,
    diagnostics: null,
  }))
  assert.match(authenticated, /Backup &amp; recovery|Backup & recovery/)
  assert.match(authenticated, /Restore from recovery phrase/)

  const authenticatedHidden = renderToStaticMarkup(React.createElement(bodies.ProfileIdentityBody, {
    ...bodyProps,
    showIdentityTools: false,
    recoveryPhrase: null,
    onCopyPhrase() {},
    onConfirmPhraseSaved() {},
    identityName: 'Channel',
    onShareChannel() {},
    onCopyKey() {},
    restoreOpen: false,
    onOpenRestore() {},
    developerModeEnabled: false,
    diagnostics: null,
  }))
  assert.doesNotMatch(authenticatedHidden, /Backup &amp; recovery|Backup & recovery/)
})
