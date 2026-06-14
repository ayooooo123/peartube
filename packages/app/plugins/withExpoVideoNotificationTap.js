/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')

// expo-video's ExpoVideoPlaybackService builds the playback notification itself
// with a plain NotificationCompat.Builder (it does NOT use media3's default
// notification provider). That builder sets a small icon, title and MediaStyle
// but never calls setContentIntent(...), so the notification has no tap target —
// tapping it on Android does nothing and never brings the app back.
// (Setting MediaSession.setSessionActivity does NOT help here: that only feeds
// media3's default provider, which expo-video bypasses.)
//
// We inject setContentIntent(...) into that NotificationCompat.Builder, pointing
// at the app's main launcher activity. MainActivity is launchMode="singleTask",
// so the launch intent brings the existing task to the foreground (preserving JS
// + the playing video) instead of recreating it. Once foregrounded,
// VideoPlayerContext's APP_FOREGROUND handler surfaces the player page
// (resumedWithBackgroundPlayback).
//
// expo autolinking compiles expo-video from its node_modules source, so patching
// that source during prebuild takes effect at gradle build time. `npm run android`
// runs `expo prebuild` on every build, so this re-applies automatically; the patch
// is idempotent (guarded by setContentIntent already being present) so repeated
// runs are safe.

const RELATIVE_SERVICE_PATH = path.join(
  'android', 'src', 'main', 'java', 'expo', 'modules', 'video',
  'playbackService', 'ExpoVideoPlaybackService.kt',
)

const MARKER = 'PearTube: open the app when the media notification is tapped'

// Inserted between `.setStyle(MediaStyleNotificationHelper.MediaStyle(session))`
// and `.build()` on the NotificationCompat.Builder. The 6-space indent matches the
// surrounding builder chain. `this` is the service (a Context); fully-qualified
// android.app.PendingIntent avoids touching the import block.
const INJECTION = `      .setContentIntent(
        // ${MARKER}.
        packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
          android.app.PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
          )
        }
      )
`

function resolveServiceFile() {
  let pkgJson
  try {
    pkgJson = require.resolve('expo-video/package.json', { paths: [__dirname] })
  } catch {
    return null
  }
  const file = path.join(path.dirname(pkgJson), RELATIVE_SERVICE_PATH)
  return fs.existsSync(file) ? file : null
}

// Exported for unit testing without a real expo-video checkout.
function patchSource(source) {
  if (source.includes('.setContentIntent(') || source.includes(MARKER)) {
    return { changed: false, source }
  }
  // Anchor on the MediaStyle line so we only touch the notification builder's
  // `.build()`, never the unrelated MediaSession.Builder.build() in the same file.
  const builderRegex = /(\.setStyle\(MediaStyleNotificationHelper\.MediaStyle\(session\)\)\n)(\s*\.build\(\))/
  if (!builderRegex.test(source)) {
    return { changed: false, source, missing: true }
  }
  const next = source.replace(builderRegex, `$1${INJECTION}$2`)
  return { changed: next !== source, source: next }
}

function withExpoVideoNotificationTap(config) {
  // Lazy require so the patch logic above stays importable for unit tests
  // without @expo/config-plugins installed.
  const { withDangerousMod } = require('@expo/config-plugins')
  return withDangerousMod(config, [
    'android',
    (config) => {
      const file = resolveServiceFile()
      if (!file) {
        console.warn('[withExpoVideoNotificationTap] Could not locate ExpoVideoPlaybackService.kt; skipping notification-tap patch')
        return config
      }
      const original = fs.readFileSync(file, 'utf8')
      const { changed, source, missing } = patchSource(original)
      if (missing) {
        console.warn('[withExpoVideoNotificationTap] NotificationCompat.Builder pattern not found; expo-video may have changed. Skipping notification-tap patch.')
        return config
      }
      if (changed) {
        fs.writeFileSync(file, source)
        console.log('[withExpoVideoNotificationTap] Patched ExpoVideoPlaybackService.kt to open app on notification tap')
      }
      return config
    },
  ])
}

module.exports = withExpoVideoNotificationTap
module.exports._patchSource = patchSource
module.exports._MARKER = MARKER
