import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

// Only these icon families ship in the app binaries. Importing any other
// @expo/vector-icons family renders tofu boxes at runtime because its TTF is
// excluded from the APK/IPA (plugins/withVectorIconFonts.js, Info.plist,
// react-native.config.js all carry the same allowlist).
const ALLOWED_FAMILIES = new Set(['Feather', 'Ionicons'])

const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      yield* walk(fullPath)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath
    }
  }
}

test('app code only imports icon families bundled into the binaries', () => {
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]@expo\/vector-icons['"]/g
  const violations = []

  for (const dir of SOURCE_DIRS) {
    const root = path.join(appRoot, dir)
    if (!fs.existsSync(root)) continue
    for (const file of walk(root)) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(importPattern)) {
        const families = match[1]
          .split(',')
          .map((name) => name.trim().split(/\s+as\s+/)[0])
          .filter(Boolean)
        for (const family of families) {
          if (!ALLOWED_FAMILIES.has(family)) {
            violations.push(`${path.relative(appRoot, file)}: ${family}`)
          }
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Icon families imported but not bundled (add the TTF to the allowlists or use Feather/Ionicons):\n${violations.join('\n')}`
  )
})

test('vector icon font allowlist matches across platform configs', () => {
  const allowed = [...ALLOWED_FAMILIES].map((family) => `${family}.ttf`)

  const plugin = fs.readFileSync(path.join(appRoot, 'plugins/withVectorIconFonts.js'), 'utf8')
  for (const font of allowed) {
    assert.match(plugin, new RegExp(font.replace('.', '\\.')), `plugin missing ${font}`)
  }

  const infoPlist = fs.readFileSync(path.join(appRoot, 'ios/PearTube/Info.plist'), 'utf8')
  const plistFonts = [...infoPlist.matchAll(/<string>([^<]+\.ttf)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(plistFonts.sort(), allowed.sort(), 'Info.plist UIAppFonts out of sync')

  const rnConfig = fs.readFileSync(path.join(appRoot, 'react-native.config.js'), 'utf8')
  const linkedFonts = [...rnConfig.matchAll(/Fonts\/([^'"]+\.ttf)/g)].map((m) => m[1])
  assert.deepEqual(linkedFonts.sort(), allowed.sort(), 'react-native.config.js assets out of sync')
})
