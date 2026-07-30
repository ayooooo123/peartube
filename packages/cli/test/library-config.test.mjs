import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import { parseArgv } from '../src/argv.js'

test('library config defaults to disabled with no folders', (t) => {
  const config = resolveRelayConfig({}, { env: {} })

  t.is(config.library.enabled, false)
  t.alike(config.library.folders, [])
  t.is(config.library.pollSeconds, 300)
  t.is(config.library.caps.maxBytes, 0)
  t.is(config.hiverelay.enabled, false)
  t.is(config.paths.libraryInventory, 'peartube-relay/db/library-inventory.json')
})

test('library folders normalize audience, confirmed, and channel name', (t) => {
  const config = resolveRelayConfig({
    library: {
      enabled: true,
      folders: [
        { path: '/media/Public', audience: 'public', confirmed: true, channelName: ' Movies ' },
        { path: '/media/Family' }
      ]
    }
  }, { env: {} })

  t.alike(config.library.folders[0], {
    path: '/media/Public',
    recursive: true,
    audience: 'public',
    confirmed: true,
    channelName: 'Movies',
    maxFiles: 5000
  })
  t.is(config.library.folders[1].audience, 'private')
  t.is(config.library.folders[1].confirmed, false)
})

test('library config rejects the modes that do not exist', (t) => {
  t.exception(() => resolveRelayConfig({
    library: { enabled: true, folders: [{ path: '/media/x', audience: 'home' }] }
  }, { env: {} }), /Invalid library audience/)

  t.exception(() => resolveRelayConfig({
    library: { enabled: true, folders: [{ path: '/media/x', audience: 'friends' }] }
  }, { env: {} }), /Invalid library audience/)
})

test('library config rejects enabled-with-no-folders and duplicates', (t) => {
  t.exception(() => resolveRelayConfig({ library: { enabled: true } }, { env: {} }), /library\.folders is empty/)
  t.exception(() => resolveRelayConfig({
    library: { enabled: true, folders: [{ path: '/media/x' }, { path: '/media/x' }] }
  }, { env: {} }), /Duplicate library folder/)
  t.exception(() => resolveRelayConfig({
    library: { enabled: true, folders: [{}] }
  }, { env: {} }), /must include a path/)
})

test('hiverelay enabled requires an endpoint', (t) => {
  t.exception(() => resolveRelayConfig({ hiverelay: { enabled: true } }, { env: {} }), /endpoint is empty/)

  const config = resolveRelayConfig({
    hiverelay: { enabled: true, endpoint: 'http://127.0.0.1:8080/' }
  }, { env: {} })
  t.is(config.hiverelay.endpoint, 'http://127.0.0.1:8080')
  t.is(config.hiverelay.seedRequest.durability, 1)
  t.is(config.hiverelay.seedRequest.revocable, true)
})

test('library env vars parse folders as JSON', (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_LIBRARY_ENABLED: 'true',
      PEARTUBE_LIBRARY_FOLDERS: JSON.stringify([{ path: '/media/Public', audience: 'public' }]),
      PEARTUBE_LIBRARY_MAX_BYTES: '1000'
    }
  })

  t.is(config.library.enabled, true)
  t.is(config.library.folders.length, 1)
  t.is(config.library.folders[0].audience, 'public')
  t.is(config.library.caps.maxBytes, 1000)

  t.exception(() => resolveRelayConfig({}, {
    env: { PEARTUBE_LIBRARY_ENABLED: 'true', PEARTUBE_LIBRARY_FOLDERS: 'not-json' }
  }), /JSON array/)
})

test('parseArgv supports library subcommand positionals and flags', (t) => {
  const parsed = parseArgv(['library', 'unseed', '/media/Family', '--json'])
  t.is(parsed.command, 'library')
  t.is(parsed.flags.action, 'unseed')
  t.is(parsed.flags.target, '/media/Family')
  t.is(parsed.flags.json, true)

  const scan = parseArgv(['library', 'scan'])
  t.is(scan.flags.action, 'scan')
  t.is(scan.flags.target, undefined)

  const flags = parseArgv(['run', '--library-path', '/media/A', '--library-path', '/media/B', '--library-audience', 'private'])
  t.alike(flags.flags.libraryPath, ['/media/A', '/media/B'])
  t.is(flags.flags.libraryAudience, 'private')
})

test('cli --library-path enables the library with private default audience', (t) => {
  const config = resolveRelayConfig({
    library: { enabled: true, folders: [{ path: '/media/A' }, { path: '/media/B' }] }
  }, { env: {} })
  t.is(config.library.enabled, true)
  t.alike(config.library.folders.map((folder) => folder.audience), ['private', 'private'])
})
