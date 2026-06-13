const fs = require('node:fs')
const path = require('node:path')
const { withDangerousMod } = require('@expo/config-plugins')

// expo-video's ExpoVideoPlaybackService builds its media3 MediaSession without a
// session activity. media3 derives the playback notification's content intent
// from the session activity, so without one, tapping the notification on Android
// does nothing — it never brings the app back to the foreground.
//
// We inject a session activity that launches the app's main launcher activity.
// MainActivity is launchMode="singleTask", so this brings the existing task to
// the foreground (preserving JS + the playing video) instead of recreating it.
// Once foregrounded, VideoPlayerContext's APP_FOREGROUND handler surfaces the
// player page (resumedWithBackgroundPlayback).
//
// expo autolinking compiles expo-video from its node_modules source, so patching
// that source during prebuild takes effect at gradle build time. `npm run android`
// runs `expo prebuild` on every build, so this re-applies automatically; the patch
// is idempotent (guarded by a marker) so repeated runs are safe.

const RELATIVE_SERVICE_PATH = path.join(
  'android', 'src', 'main', 'java', 'expo', 'modules', 'video',
  'playbackService', 'ExpoVideoPlaybackService.kt',
)

const MARKER = 'PearTube: open the app when the media notification is tapped'

// Inserted between `.setCustomLayout(...)` and `.build()` on MediaSession.Builder.
// Fully-qualified android.app.PendingIntent avoids touching the import block.
const INJECTION = `        .also { builder ->
          // ${MARKER}.
          packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
            builder.setSessionActivity(
              android.app.PendingIntent.getActivity(
                this@ExpoVideoPlaybackService,
                0,
                launchIntent,
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
              )
            )
          }
        }
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
  if (source.includes(MARKER) || source.includes('.setSessionActivity(')) {
    return { changed: false, source }
  }
  // Match the `.build()` that closes the MediaSession.Builder chain, anchored on
  // the preceding `.setCustomLayout(...)` line so we never patch an unrelated build().
  const builderRegex = /(\.setCustomLayout\(ImmutableList\.of\(seekBackwardButton, seekForwardButton\)\)\n)(\s*\.build\(\))/
  if (!builderRegex.test(source)) {
    return { changed: false, source, missing: true }
  }
  const next = source.replace(builderRegex, `$1${INJECTION}$2`)
  return { changed: next !== source, source: next }
}

function withExpoVideoNotificationTap(config) {
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
        console.warn('[withExpoVideoNotificationTap] MediaSession.Builder pattern not found; expo-video may have changed. Skipping notification-tap patch.')
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
