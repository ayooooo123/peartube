import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const profilePath = new URL('../app/profile.tsx', import.meta.url)

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
  assert.match(src, /renderRecoveryPhraseCard/, 'a recovery phrase card must be rendered')
  assert.match(src, /confirmRecoveryPhraseSaved/, 'dismissing the phrase requires explicit confirmation')
  assert.match(src, /setRecoveryPhrase\(null\)/, 'confirmation clears the phrase from memory')

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
  const src = await source()

  const onboardingStart = src.indexOf('// ---------- Onboarding')
  const onboardingEnd = src.indexOf('// ---------- Authenticated profile')
  const onboarding = src.slice(onboardingStart, onboardingEnd)
  assert.match(onboarding, /renderRestoreCard\(\)/, 'onboarding must offer restore — a fresh install is the primary recovery scenario')

  const mainStart = src.indexOf('{/* Backup & recovery */}')
  assert.notEqual(mainStart, -1, 'authenticated profile must have a Backup & recovery section')
  const main = src.slice(mainStart, mainStart + 800)
  assert.match(main, /renderRestoreCard\(\)/, 'authenticated profile must offer restore too')
})
