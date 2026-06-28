import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrustedClients, normalizeClientKey, mergeTrustedClientKeys } from '../src/trusted-clients.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

function tmpStorage() {
  return mkdtempSync(join(tmpdir(), 'peartube-trusted-'))
}

test('normalizeClientKey validates 64-char hex', function (t) {
  t.is(normalizeClientKey(KEY_A), KEY_A)
  t.is(normalizeClientKey(KEY_A.toUpperCase()), KEY_A, 'lowercases')
  t.is(normalizeClientKey('  ' + KEY_A + '  '), KEY_A, 'trims')
  t.is(normalizeClientKey('xyz'), null)
  t.is(normalizeClientKey('a'.repeat(63)), null)
  t.is(normalizeClientKey(''), null)
})

test('mergeTrustedClientKeys unions and de-dupes valid keys', function (t) {
  const merged = mergeTrustedClientKeys([KEY_A, 'bad'], [KEY_A.toUpperCase(), KEY_B])
  t.alike(merged.sort(), [KEY_A, KEY_B].sort())
})

test('TrustedClients add/list/has/remove with persistence', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))

  const trusted = await TrustedClients.open({ storagePath })
  await trusted.add({ key: KEY_A, label: "Alice's phone" })
  await trusted.add({ key: KEY_B })

  t.is(trusted.has(KEY_A), true)
  t.is(trusted.has('c'.repeat(64)), false)
  t.alike(trusted.keys().sort(), [KEY_A, KEY_B].sort())
  t.is(trusted.list().find((c) => c.key === KEY_A).label, "Alice's phone")

  // Re-open to confirm round-trip.
  const reopened = await TrustedClients.open({ storagePath })
  t.is(reopened.has(KEY_B), true)

  t.is(await reopened.remove(KEY_B), true)
  t.is(await reopened.remove(KEY_B), false, 'removing twice is a no-op')
  t.is(reopened.has(KEY_B), false)
})

test('TrustedClients rejects invalid keys', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const trusted = await TrustedClients.open({ storagePath })
  await t.exception(() => trusted.add({ key: 'not-a-key' }))
})

test('TrustedClients preserves addedAt and updates label on re-add', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const trusted = await TrustedClients.open({ storagePath })
  const first = await trusted.add({ key: KEY_A, label: 'Original' })
  const second = await trusted.add({ key: KEY_A, label: 'Renamed' })
  t.is(second.addedAt, first.addedAt, 'addedAt is stable')
  t.is(second.label, 'Renamed')
})
