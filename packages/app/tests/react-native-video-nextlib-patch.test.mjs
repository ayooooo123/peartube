import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('react-native-video Android ExoPlayer uses NextRenderersFactory with NextLib enabled but not forced ahead of platform decoders', () => {
  const relativePath = 'node_modules/react-native-video/android/src/main/java/com/brentvatne/exoplayer/ReactExoplayerView.java'
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) return
  const source = readRepoFile(relativePath)

  assert.match(source, /import io\.github\.anilbeesetti\.nextlib\.media3ext\.ffdecoder\.NextRenderersFactory;/)
  assert.match(source, /new NextRenderersFactory\(getContext\(\)\)/)
  assert.match(source, /setExtensionRendererMode\(DefaultRenderersFactory\.EXTENSION_RENDERER_MODE_ON\)/)
  assert.doesNotMatch(source, /EXTENSION_RENDERER_MODE_PREFER/)
  assert.doesNotMatch(source, /EXTENSION_RENDERER_MODE_OFF/)
})

test('react-native-video Android build declares the NextLib Media3 extension dependency', () => {
  const relativePath = 'node_modules/react-native-video/android/build.gradle'
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) return
  const source = readRepoFile(relativePath)

  assert.match(source, /io\.github\.anilbeesetti:nextlib-media3ext:1\.8\.0-0\.9\.0/)
})

test('patch-package artifact captures the checked-in react-native-video NextLib patch', () => {
  const source = readAppFile('patches/react-native-video+6.19.1.patch')

  assert.match(source, /diff --git a\/node_modules\/react-native-video\/android\/build\.gradle b\/node_modules\/react-native-video\/android\/build\.gradle/)
  assert.match(source, /diff --git a\/node_modules\/react-native-video\/android\/src\/main\/java\/com\/brentvatne\/exoplayer\/ReactExoplayerView\.java b\/node_modules\/react-native-video\/android\/src\/main\/java\/com\/brentvatne\/exoplayer\/ReactExoplayerView\.java/)
  assert.match(source, /NextRenderersFactory/)
  assert.match(source, /nextlib-media3ext/)
})
