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

// Only the icon families actually imported by the app. Shipping the full
// @expo/vector-icons set adds ~3.6 MB of dead TTFs to the APK.
const INCLUDED_FONTS = new Set(['Feather.ttf', 'Ionicons.ttf'])

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

      const fonts = fs.readdirSync(FONTS_DIR).filter((f) => INCLUDED_FONTS.has(f))
      let copied = 0

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
