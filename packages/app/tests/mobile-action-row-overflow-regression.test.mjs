import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('mobile watch action rows wrap instead of pushing More off screen when labels grow', () => {
  const watchRouteSource = readAppFile('app/video/[id].tsx')
  const sharedStylesSource = readAppFile('components/video-player/styles.ts')
  const sharedActionButtonSource = readAppFile('components/video-player/ActionButton.tsx')

  for (const [name, source] of [
    ['watch route', watchRouteSource],
    ['shared player styles', sharedStylesSource],
  ]) {
    assert.match(source, /actions:\s*\{[\s\S]*flexWrap:\s*'wrap'/, `${name} action row should wrap`) 
    assert.match(source, /actions:\s*\{[\s\S]*justifyContent:\s*'space-between'/, `${name} action row should distribute wrapped buttons`) 
    assert.match(source, /actionButton:\s*\{[\s\S]*width:\s*'16\.66%'/, `${name} action buttons should have six-up percentage slots`) 
    assert.match(source, /actionButton:\s*\{[\s\S]*minWidth:\s*56/, `${name} action buttons should keep a tappable minimum`) 
    assert.match(source, /actionLabel:\s*\{[\s\S]*numberOfLines/, `${name} action labels should be clamped through Text props or style marker`) 
  }

  assert.match(
    watchRouteSource,
    /<Text\s+numberOfLines=\{1\}\s+ellipsizeMode="tail"\s+style=\{\[styles\.actionLabel, active && styles\.actionLabelActive\]\}>/,
    'watch route action labels should truncate long labels like Like (123) instead of widening the row',
  )
  assert.match(
    sharedActionButtonSource,
    /<Text\s+numberOfLines=\{1\}\s+ellipsizeMode="tail"\s+style=\{\[styles\.actionLabel, active && styles\.actionLabelActive\]\}>/,
    'shared action labels should truncate long labels like Like (123) instead of widening the row',
  )
})
