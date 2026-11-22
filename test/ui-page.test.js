// The Rust relay's image builds its page from this repository's `src/ui.js` and nothing else of the app. The first
// stage of peartube-native's `relay.Dockerfile` copies exactly the paths in COPIED into an empty folder and runs
//   node -e "import('./src/ui.js').then(m => require('fs').writeFileSync('web/index.html', m.page))"
// there, with no `node_modules`. This test does the same. A page that needs one more file (a module beside
// `src/ui.js`, an npm package, a part read from disk) fails here, before it fails that image's build at a release:
// the import throws, or the page that comes out differs from the one this checkout serves.
// A path belongs in COPIED only once that Dockerfile copies it.
// Writes desktop/target/e2e/ui-page-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COPIED = ['src/ui.js', 'web/assets']
const sha256 = text => createHash('sha256').update(text).digest('hex')

test('the page renders from only the paths that the Rust relay image copies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-page-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const path of COPIED) cpSync(join(ROOT, path), join(dir, path), { recursive: true })

  const alone = (await import(pathToFileURL(join(dir, 'src/ui.js')).href)).page
  const whole = (await import('../src/ui.js')).page
  assert.equal(typeof alone, 'string', 'src/ui.js exports `page` as a string')
  assert.ok(alone.startsWith('<!doctype html>') && alone.trimEnd().endsWith('</html>'), 'the page is one whole HTML document')

  let at = 0
  while (at < whole.length && alone[at] === whole[at]) at++
  assert.equal(
    sha256(alone),
    sha256(whole),
    'the page built from ' + COPIED.join(' + ') + ' differs from this checkout\'s page at character ' + at +
      ': ' + JSON.stringify(alone.slice(at, at + 60)) + ' against ' + JSON.stringify(whole.slice(at, at + 60))
  )

  const out = join(ROOT, 'desktop/target/e2e')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'ui-page-result.json'), JSON.stringify({
    copied: COPIED,
    files: readdirSync(dir, { recursive: true }).length,
    pageBytes: Buffer.byteLength(alone),
    pageSha256: sha256(alone)
  }, null, 2) + '\n')
})
