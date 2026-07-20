import test from 'brittle'
import {
  ADD_PREFERENCE_DEFAULTS,
  expandHome,
  describeSecret,
  normalizeNetworkTrust,
  redactPreferences,
  resolveAddPreferences,
  updateContentConfig
} from '../src/add/preferences.js'

test('resolution precedence is flags over env over config over defaults', (t) => {
  const config = {
    content: {
      storagePath: '/config/content',
      tmdbApiKey: 'config-key',
      ytDlpPath: '/config/yt-dlp',
      ytDlpCookiesPath: '/config/cookies.txt',
      searchLimit: 20,
      claimRetentionDays: 45
    }
  }
  const env = {
    TMDB_API_KEY: 'env-key',
    PEARTUBE_YTDLP_PATH: '/env/yt-dlp',
    PEARTUBE_YTDLP_COOKIES: '/env/cookies.txt'
  }
  const flags = { storage: '/flag/content', tmdbApiKey: 'flag-key' }

  const prefs = resolveAddPreferences({ flags, env, config })
  t.is(prefs.storagePath, '/flag/content', 'flag wins for storage')
  t.is(prefs.tmdbApiKey, 'flag-key', 'flag wins for tmdb key')
  t.is(prefs.tmdbApiKeySource, 'flag')
  t.is(prefs.ytDlpPath, '/env/yt-dlp', 'env wins over config for yt-dlp path')
  t.is(prefs.ytDlpCookiesPath, '/env/cookies.txt', 'env wins over config for cookies')
  t.is(prefs.searchLimit, 20, 'config supplies non-secret values')
  t.is(prefs.claimRetentionDays, 45)
})

test('env overrides config and is reported as configured without leaking value', (t) => {
  const config = { content: { tmdbApiKey: 'config-key' } }
  const prefs = resolveAddPreferences({ flags: {}, env: { TMDB_API_KEY: 'env-secret' }, config })
  t.is(prefs.tmdbApiKey, 'env-secret')
  t.is(prefs.tmdbApiKeySource, 'env')
  const redacted = redactPreferences(prefs)
  t.is(redacted.tmdbApiKey, 'configured')
  t.absent(JSON.stringify(redacted).includes('env-secret'), 'redacted view omits the secret')
  t.absent(JSON.stringify(redacted).includes('config-key'))
})

test('absent keys fall back to defaults and keep creator/local flows available', (t) => {
  const prefs = resolveAddPreferences({ flags: {}, env: {}, config: {} })
  t.is(prefs.storagePath, expandHome(ADD_PREFERENCE_DEFAULTS.storagePath))
  t.is(prefs.tmdbApiKey, '')
  t.is(prefs.tmdbApiKeySource, null)
  t.is(prefs.ytDlpPath, ADD_PREFERENCE_DEFAULTS.ytDlpPath)
  t.is(prefs.ytDlpCookiesPath, '')
  t.is(prefs.searchLimit, ADD_PREFERENCE_DEFAULTS.searchLimit)
  t.is(describeSecret(prefs.tmdbApiKey), 'not set')
  t.is(describeSecret('anything'), 'configured')
})

test('network trust is normalized and forwarded without duplication', (t) => {
  const hexA = 'a'.repeat(64)
  const hexB = 'B'.repeat(64)
  const config = {
    network: {
      trustedRelayKeys: [` ${hexA} `, hexB, hexA, 'not-hex', ''],
      blindPeerMirrors: [hexB.toLowerCase(), hexB]
    }
  }
  const prefs = resolveAddPreferences({ flags: {}, env: {}, config })
  t.alike(prefs.network.trustedRelayKeys, [hexA, hexB.toLowerCase()], 'lowercased, deduped, invalid dropped')
  t.alike(prefs.network.blindPeerMirrors, [hexB.toLowerCase()])
  t.alike(normalizeNetworkTrust({ trustedRelayKeys: [hexA, hexA] }).trustedRelayKeys, [hexA])
})

test('content config update preserves unrelated keys and comments and reports secrets', (t) => {
  const original = [
    'mode: public',
    '# keep this comment',
    'storage:',
    '  path: /var/lib/peartube-relay',
    'content:',
    '  storagePath: /old/content',
    '  searchLimit: 8',
    'logging:',
    '  level: info',
    ''
  ].join('\n')

  const { text, containsSecret } = updateContentConfig(original, {
    storagePath: '/new/content',
    tmdbApiKey: 'secret-token'
  })

  t.ok(text.includes('# keep this comment'), 'comments preserved')
  t.ok(text.includes('mode: public'))
  t.ok(text.includes('level: info'), 'later unrelated keys preserved')
  t.ok(text.includes('  storagePath: /new/content'), 'updated field replaced')
  t.ok(text.includes('  searchLimit: 8'), 'untouched content field preserved')
  t.ok(text.includes('  tmdbApiKey: secret-token'), 'secret added under content')
  t.is(containsSecret, true)
  t.is(text.match(/^content:/gm).length, 1, 'exactly one content block')

  const created = updateContentConfig('', { storagePath: '/fresh' })
  t.ok(created.text.includes('content:'))
  t.ok(created.text.includes('  storagePath: /fresh'))
  t.is(created.containsSecret, false)
})

test('relay keys merge from flags, env, and config and dedupe', (t) => {
  const k1 = 'a'.repeat(64)
  const k2 = 'b'.repeat(64)
  const k3 = 'c'.repeat(64)
  const prefs = resolveAddPreferences({
    flags: { relay: [k1] },
    env: { PEARTUBE_RELAYS: `${k2} ${k3}` },
    config: { network: { trustedRelayKeys: [k1] } }
  })
  t.alike(prefs.network.trustedRelayKeys, [k1, k2, k3], 'merged across sources and deduped')
  t.alike(prefs.network.blindPeerMirrors, [], 'relay keys do not leak into the mirror list')
})
