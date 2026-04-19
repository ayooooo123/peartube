/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Expo config plugin to link @expo/vector-icons font files into the native
 * Android and iOS projects so icon glyphs render instead of text fallbacks.
 *
 * This survives `expo prebuild --clean` because it runs as part of the
 * prebuild plugin pipeline.
 */
const { withDangerousMod } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

const FONTS_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  '@expo',
  'vector-icons',
  'build',
  'vendor',
  'react-native-vector-icons',
  'Fonts'
)

const ANDROID_ICON_FONT_ALLOWLIST = [
  'Feather.ttf',
  'Ionicons.ttf',
]

function filterAndroidVectorIconFonts(fonts) {
  const allowed = new Set(ANDROID_ICON_FONT_ALLOWLIST)
  return (fonts || []).filter((font) => allowed.has(font))
}

function withVectorIconFonts(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const assetsDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets',
        'fonts'
      )

      fs.mkdirSync(assetsDir, { recursive: true })

      if (!fs.existsSync(FONTS_DIR)) {
        console.warn('[withVectorIconFonts] Fonts source not found:', FONTS_DIR)
        return cfg
      }

      const availableFonts = fs.readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf'))
      const fonts = filterAndroidVectorIconFonts(availableFonts)
      let copied = 0

      for (const font of fs.readdirSync(assetsDir).filter((f) => f.endsWith('.ttf'))) {
        if (!fonts.includes(font)) {
          fs.unlinkSync(path.join(assetsDir, font))
        }
      }

      for (const font of fonts) {
        const src = path.join(FONTS_DIR, font)
        const dest = path.join(assetsDir, font)
        fs.copyFileSync(src, dest)
        copied++
      }

      console.log(`[withVectorIconFonts] Copied ${copied} font files to Android assets`)
      return cfg
    },
  ])
}

module.exports = withVectorIconFonts
module.exports.ANDROID_ICON_FONT_ALLOWLIST = ANDROID_ICON_FONT_ALLOWLIST
module.exports.filterAndroidVectorIconFonts = filterAndroidVectorIconFonts
