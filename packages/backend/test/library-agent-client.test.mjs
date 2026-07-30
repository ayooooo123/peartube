import test from 'brittle'
import { createLibraryAgentClient, emptyStatus } from '../src/library-agent-client.js'

test('library agent client returns disabled empty status without endpoint', async (t) => {
  const client = createLibraryAgentClient({ endpoint: null })
  const status = await client.status()
  t.alike(status, emptyStatus())
  const scan = await client.scan()
  t.is(scan.error, 'no-endpoint')
  const confirm = await client.confirm('/media/Public')
  t.is(confirm.confirmed, false)
})

test('library agent client proxies status and actions to HTTP agent', async (t) => {
  const calls = []
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body })
    if (String(url).endsWith('/library/status')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          enabled: true,
          folders: 1,
          totalItems: 3,
          durableItems: 2,
          selfOnlyItems: 1,
          pendingApprovalItems: 0,
          failedItems: 0,
          bytes: 100,
          capBytes: 1000,
          importsPaused: false,
          hiverelayDetected: true,
          hiverelayEndpoint: 'http://hiverelay:9100'
        })
      }
    }
    if (String(url).endsWith('/library/scan')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ scanned: 3, imported: 1, skipped: 2, failed: 0 }) }
    }
    if (String(url).endsWith('/library/confirm')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ confirmed: true }) }
    }
    if (String(url).endsWith('/library/unseed')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ unseeded: 1, state: 'unseeded' }) }
    }
    if (String(url).endsWith('/library/verify')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ verified: 2, failures: 0 }) }
    }
    return { ok: false, status: 404, text: async () => '' }
  }

  const client = createLibraryAgentClient({ endpoint: 'http://agent:8174/', fetchFn })
  t.alike(await client.status(), {
    enabled: true,
    folders: 1,
    totalItems: 3,
    durableItems: 2,
    selfOnlyItems: 1,
    pendingApprovalItems: 0,
    failedItems: 0,
    bytes: 100,
    capBytes: 1000,
    importsPaused: false,
    hiverelayDetected: true,
    hiverelayEndpoint: 'http://hiverelay:9100'
  })
  t.alike(await client.scan(), { scanned: 3, imported: 1, skipped: 2, failed: 0 })
  t.alike(await client.confirm('/media/Public'), { confirmed: true, error: null })
  t.alike(await client.unseed('/media/Public/a.mp4'), { unseeded: 1, state: 'unseeded', error: null })
  t.alike(await client.verify(), { verified: 2, failures: 0, error: null })
  t.is(calls.length, 5)
  t.ok(calls[0].url.endsWith('/library/status'))
})
