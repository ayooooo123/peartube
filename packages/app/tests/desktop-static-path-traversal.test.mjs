/**
 * The desktop shell serves the exported Expo bundle over a loopback HTTP port.
 * That surface carries no capability — any local process can reach it, and any
 * page the user has open can load content types the browser fetches
 * cross-origin — so path containment is the only thing between a request and
 * the filesystem.
 *
 * `new URL()` collapses literal `../`, but percent-encoded separators survive
 * parsing and only become separators when the pathname is decoded. Before the
 * containment check, `/..%2F..%2Fetc%2Fpasswd` was joined, decoded and handed
 * straight to `Bun.file()`.
 *
 * These tests drive the real production handler from src/bun/static-files.ts
 * against a fixture bundle with files planted outside it, and record every
 * path the handler asks to open — so an escape is proven not to be read, not
 * merely to produce a 404 body.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createStaticFileHandler,
  extensionOf,
  isContained,
  resolveStaticPath,
} from '../src/bun/static-files.ts'

const INDEX_HTML = [
  '<!DOCTYPE html><html><head><title>PearTube</title></head><body>',
  '<div id="root"></div>',
  '<script src="/_expo/static/js/web/entry-deadbeef.js"></script>',
  '</body></html>',
].join('\n')

const ASSET_PATH = '_expo/static/js/web/entry-deadbeef.js'
const ASSET_BODY = 'console.log("expo bundle")\n'
const SECRET_BODY = 'loopback-reachable-secret\n'
const EVIL_HTML = '<html><body>sibling leak</body></html>'

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-static-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const viewsDir = path.join(root, 'views')
  fs.mkdirSync(path.join(viewsDir, path.dirname(ASSET_PATH)), { recursive: true })
  fs.writeFileSync(path.join(viewsDir, 'index.html'), INDEX_HTML)
  fs.writeFileSync(path.join(viewsDir, ASSET_PATH), ASSET_BODY)

  // Planted outside the bundle. Nothing a request can spell may reach these.
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET_BODY)
  fs.writeFileSync(path.join(root, 'evil.html'), EVIL_HTML)
  // The sibling-prefix attack: `startsWith(viewsDir)` accepts `views-evil`.
  fs.mkdirSync(path.join(root, 'views-evil'), { recursive: true })
  fs.writeFileSync(path.join(root, 'views-evil', 'leak.txt'), SECRET_BODY)

  const opened = []
  const handler = createStaticFileHandler({
    viewsDir: fs.realpathSync(viewsDir),
    openFile: (filePath) => {
      opened.push(filePath)
      let size = 0
      try {
        const stat = fs.statSync(filePath)
        size = stat.isFile() ? stat.size : 0
      } catch { size = 0 }
      const body = size > 0 ? fs.readFileSync(filePath) : ''
      return { size, text: async () => body.toString('utf8'), body }
    },
    ipcPort: () => 45678,
  })

  return {
    root,
    viewsDir: fs.realpathSync(viewsDir),
    opened,
    get(pathname) {
      return handler({ url: 'http://127.0.0.1:41234' + pathname })
    },
  }
}

function escapedOpens(fixture) {
  return fixture.opened.filter((filePath) => !isContained(fixture.viewsDir, filePath))
}

test('encoded traversal cannot read a file next to the bundle', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/..%2Fsecret.txt')

  assert.equal(response.status, 404)
  const body = await response.text()
  assert.ok(!body.includes('loopback-reachable-secret'), 'secret body must not be served')
  assert.deepEqual(escapedOpens(fixture), [], 'no file outside the bundle may be opened')
})

test('a lowercase-encoded dot-dot traversal is refused', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/%2e%2e%2fsecret.txt')

  assert.equal(response.status, 404)
  assert.ok(!(await response.text()).includes('loopback-reachable-secret'))
  assert.deepEqual(escapedOpens(fixture), [])
})

test('a deep encoded traversal below a real segment is refused', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/_expo/..%2F..%2Fsecret.txt')

  assert.equal(response.status, 404)
  assert.ok(!(await response.text()).includes('loopback-reachable-secret'))
  assert.deepEqual(escapedOpens(fixture), [])
})

test('the html branch cannot be pointed outside the bundle either', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/..%2Fevil.html')

  assert.equal(response.status, 404)
  assert.ok(!(await response.text()).includes('sibling leak'))
  assert.deepEqual(escapedOpens(fixture), [])
})

test('a sibling directory sharing the bundle path prefix is refused', async (t) => {
  const fixture = createFixture(t)

  // `<root>/views-evil/leak.txt` passes a bare startsWith(`<root>/views`).
  const response = await fixture.get('/..%2Fviews-evil%2Fleak.txt')

  assert.equal(response.status, 404)
  assert.ok(!(await response.text()).includes('loopback-reachable-secret'))
  assert.deepEqual(escapedOpens(fixture), [])
  assert.equal(isContained(path.join(fixture.root, 'views'), path.join(fixture.root, 'views-evil', 'leak.txt')), false)
})

test('a malformed percent escape is refused instead of throwing', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/%zz')

  assert.equal(response.status, 404)
  assert.equal(resolveStaticPath(fixture.viewsDir, '/%zz'), null)
})

test('a NUL-truncating path is refused', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/index.html%00.png')

  assert.equal(response.status, 404)
  // Rejected outright, not merely missed by a stat: a NUL is what turns
  // `index.html\0.png` into `index.html` inside a C path API.
  assert.equal(resolveStaticPath(fixture.viewsDir, '/index.html%00.png'), null)
  assert.deepEqual(escapedOpens(fixture), [])
})

test('the bundle root and index still serve the exported html', async (t) => {
  const fixture = createFixture(t)

  for (const pathname of ['/', '/index.html']) {
    const response = await fixture.get(pathname)
    assert.equal(response.status, 200, pathname)
    assert.equal(response.headers.get('content-type'), 'text/html')
    const html = await response.text()
    assert.ok(html.includes('<div id="root"></div>'), pathname)
    // The view entrypoint is injected ahead of the Expo bundle.
    assert.ok(
      html.indexOf('views://app/index.js') < html.indexOf('entry-deadbeef.js'),
      pathname,
    )
  }
})

test('a hashed expo asset still serves with its mime type', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/' + ASSET_PATH)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/javascript')
  assert.equal(await response.text(), ASSET_BODY)
})

test('an extension-less route still falls back to index.html', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/channel/abc123')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html')
  assert.ok((await response.text()).includes('<div id="root"></div>'))
})

test('a missing asset with an extension is a 404, not the index html', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/_expo/static/js/web/missing.js')

  assert.equal(response.status, 404)
  assert.ok(!(await response.text()).includes('<div id="root"></div>'))
})

test('the ipc port endpoint still answers', async (t) => {
  const fixture = createFixture(t)

  const response = await fixture.get('/__peartube_ipc_port')

  assert.deepEqual(await response.json(), { port: 45678 })
})

test('extension detection ignores dots in the bundle directory path', () => {
  // A packaged build lives under `PearTube-dev.app/...`; taking the extension
  // from the whole path would make every navigation route a 404.
  assert.equal(extensionOf('/Apps/PearTube-dev.app/views/app/channel/abc'), '')
  assert.equal(extensionOf('/Apps/PearTube-dev.app/views/app/index.html'), '.html')
  assert.equal(extensionOf('/Apps/PearTube-dev.app/views/app/entry-9f.JS'), '.js')
})

test('resolveStaticPath decodes exactly once', (t) => {
  const fixture = createFixture(t)

  // Double-decoding would turn this into `../secret.txt`; one pass leaves a
  // literal `%2e%2e%2f` filename, which lives inside the bundle.
  const resolved = resolveStaticPath(fixture.viewsDir, '/%252e%252e%252fsecret.txt')

  assert.equal(resolved, path.join(fixture.viewsDir, '%2e%2e%2fsecret.txt'))
})
