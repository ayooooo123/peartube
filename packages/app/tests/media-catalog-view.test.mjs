import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadView(platform) {
  const result = await build({
    entryPoints: [path.join(appRoot, 'components/media/MediaCatalogView.tsx')],
    bundle: true,
    format: 'cjs',
    external: ['react', 'react-dom'],
    platform: 'node',
    resolveExtensions: platform === 'web'
      ? ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.jsx', '.web.js', '.jsx', '.js', '.json']
      : ['.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: { 'react-native': 'react-native-web' },
    tsconfigRaw: { compilerOptions: { jsx: 'react', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, `.media-catalog-${platform}-`))
  const output = path.join(directory, 'view.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const item = {
  entityId: 'work:alpha',
  entityKind: 'work',
  title: 'Alpha',
  subtitle: 'Episode one',
  claimCount: 3,
  conflictCount: 1,
  sources: [{
    publicationId: 'pub:one',
    publisherId: 'publisher:trusted',
    manifestId: 'manifest:one',
    selected: true,
    archiveState: 'pledged',
    availabilityState: 'available',
  }],
  renditions: [{
    renditionId: 'rendition:one',
    purpose: 'primary',
    format: 'video/mp4',
    coreKey: 'a'.repeat(64),
    coreLength: 2,
    treeHash: 'b'.repeat(64),
    byteLength: 2048,
  }],
}

test('native and web media catalog views server-render source, archive, and trust summaries', async t => {
  for (const platform of ['native', 'web']) {
    await t.test(platform, async () => {
      const view = await loadView(platform)
      const html = renderToStaticMarkup(React.createElement(view.MediaCatalogView, {
        title: 'Discover media',
        state: { status: 'ready', items: [item], refreshing: false, loadingMore: false, nextCursor: 'next' },
        diagnostic: null,
        onRefresh() {},
        onLoadNext() {},
        onEntityPress() {},
      }))
      assert.match(html, /Alpha/)
      assert.match(html, /publisher:trusted/)
      assert.match(html, /Archive: pledged/)
      assert.match(html, /3 verified claims/)
      assert.match(html, /1 conflict/)
      assert.match(html, /Load more/)
    })
  }
})

test('media catalog view renders structured empty and error diagnostics', async () => {
  const view = await loadView('native')
  for (const diagnostic of [
    { kind: 'empty', title: 'No media is available yet', detail: 'Joining trusted catalogs', actionLabel: 'Refresh catalog' },
    { kind: 'error', title: 'Media catalog unavailable', detail: 'Replay failed', errorCode: 'REPLAY_FAILED', actionLabel: 'Try again' },
  ]) {
    const html = renderToStaticMarkup(React.createElement(view.MediaCatalogView, {
      state: { status: diagnostic.kind === 'error' ? 'error' : 'ready', items: [], refreshing: false, loadingMore: false },
      diagnostic,
      onRefresh() {},
      onLoadNext() {},
      onEntityPress() {},
    }))
    assert.match(html, new RegExp(diagnostic.title))
    assert.match(html, new RegExp(diagnostic.detail))
    if (diagnostic.errorCode) assert.match(html, /REPLAY_FAILED/)
  }
})
