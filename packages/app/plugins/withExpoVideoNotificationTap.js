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

const RELATIVE_DATA_SOURCE_PATH = path.join(
  'android', 'src', 'main', 'java', 'expo', 'modules', 'video',
  'utils', 'DataSourceUtils.kt',
)

const MARKER = 'PearTube: open the app when the media notification is tapped'
const DATA_SOURCE_MARKER = 'PearTube: local blob-server streams use Media3 no-timeout HTTP'
const DATA_SOURCE_RANGE_MARKER = 'PearTube: local blob-server applying Range'
const EXPO_VIDEO_SOURCE_MARKER = 'PearTube: compile patched expo-video Android sources'
const EXPO_VIDEO_SUBSTITUTION_MARKER = 'PearTube: use patched expo-video project for Android playback'

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

function resolveExpoVideoFile(relativePath) {
  let pkgJson
  try {
    pkgJson = require.resolve('expo-video/package.json', { paths: [__dirname] })
  } catch {
    return null
  }
  const file = path.join(path.dirname(pkgJson), relativePath)
  return fs.existsSync(file) ? file : null
}

function resolveServiceFile() {
  return resolveExpoVideoFile(RELATIVE_SERVICE_PATH)
}

function resolveDataSourceFile() {
  return resolveExpoVideoFile(RELATIVE_DATA_SOURCE_PATH)
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

function patchDataSourceSource(source) {
  const alreadyPatched = source.includes(DATA_SOURCE_MARKER)

  let next = source
  if (!alreadyPatched) {
    const baseFactoryRegex = /fun buildBaseDataSourceFactory\(context: Context, videoSource: VideoSource\): DataSource\.Factory \{\n {2}return if \(videoSource\.uri\?\.scheme\?\.startsWith\("http"\) == true\) \{\n {4}buildOkHttpDataSourceFactory\(context, videoSource\)\n {2}\} else \{\n {4}DefaultDataSource\.Factory\(context\)\n {2}\}\n\}/
    if (!baseFactoryRegex.test(source)) {
      return { changed: false, source, missing: true }
    }

    if (!next.includes('import android.net.Uri')) {
      const importAnchor = 'import android.content.Context\n'
      if (!next.includes(importAnchor)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(importAnchor, `${importAnchor}import android.net.Uri\n`)
    }
    if (!next.includes('import android.util.Log')) {
      const importAnchor = 'import android.content.Context\n'
      if (!next.includes(importAnchor)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(importAnchor, `${importAnchor}import android.util.Log\n`)
    }
    if (!next.includes('import androidx.media3.datasource.DataSpec')) {
      const importAnchor = 'import androidx.media3.datasource.DataSource\n'
      if (!next.includes(importAnchor)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(importAnchor, `${importAnchor}import androidx.media3.datasource.DataSpec\n`)
    }
    if (!next.includes('import androidx.media3.datasource.DefaultHttpDataSource')) {
      const importAnchor = 'import androidx.media3.datasource.DefaultDataSource\n'
      if (!next.includes(importAnchor)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(importAnchor, `${importAnchor}import androidx.media3.datasource.DefaultHttpDataSource\n`)
    }
    if (!next.includes('import androidx.media3.datasource.TransferListener')) {
      const importAnchor = 'import androidx.media3.datasource.DefaultHttpDataSource\n'
      if (!next.includes(importAnchor)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(importAnchor, `${importAnchor}import androidx.media3.datasource.TransferListener\n`)
    }

    next = next.replace(
      baseFactoryRegex,
      `fun buildBaseDataSourceFactory(context: Context, videoSource: VideoSource): DataSource.Factory {
  return if (isPearTubeLocalBlobStream(videoSource)) {
    buildPearTubeBlobDataSourceFactory(context, videoSource)
  } else if (videoSource.uri?.scheme?.startsWith("http") == true) {
    buildOkHttpDataSourceFactory(context, videoSource)
  } else {
    DefaultDataSource.Factory(context)
  }
}`,
    )

    const factory = `
@OptIn(UnstableApi::class)
fun buildPearTubeBlobDataSourceFactory(context: Context, videoSource: VideoSource): DataSource.Factory {
  val uri = videoSource.uri
  Log.i("PearTubeVideo", "${DATA_SOURCE_MARKER}: \${uri?.host}:\${uri?.port}")

  val applicationName = getApplicationName(context).filter { it.code in 0..127 }
  val defaultUserAgent = Util.getUserAgent(context, applicationName)

  val upstreamFactory = DefaultHttpDataSource.Factory().apply {
    setConnectTimeoutMs(30000)
    setReadTimeoutMs(0)

    val headers = videoSource.headers
    headers?.takeIf { it.isNotEmpty() }?.let {
      setDefaultRequestProperties(it)
    }
    val userAgent = headers?.get("User-Agent") ?: defaultUserAgent
    setUserAgent(userAgent)
  }

  return DataSource.Factory {
    PearTubeLoggingDataSource(upstreamFactory.createDataSource())
  }
}

@OptIn(UnstableApi::class)
private class PearTubeLoggingDataSource(
  private val upstream: DataSource
) : DataSource {
  private var opened = false
  private var firstReadLogged = false

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    val requestSpec = withPearTubeBlobRangeHeader(dataSpec)
    Log.i(
      "PearTubeVideo",
      "PearTube: local blob-server open: uri=\${redactPearTubeUriForLog(dataSpec.uri)} position=\${dataSpec.position} length=\${dataSpec.length} range=\${requestSpec.httpRequestHeaders["Range"] ?: "none"}"
    )
    return try {
      val result = upstream.open(requestSpec)
      opened = true
      Log.i(
        "PearTubeVideo",
        "PearTube: local blob-server opened: bytes=$result responseUri=\${redactPearTubeUriForLog(upstream.uri)}"
      )
      result
    } catch (error: Exception) {
      Log.e(
        "PearTubeVideo",
        "PearTube: local blob-server open failed: \${error.javaClass.simpleName}: \${error.message}"
      )
      throw error
    }
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    return try {
      val result = upstream.read(buffer, offset, length)
      if (!firstReadLogged && result != 0) {
        firstReadLogged = true
        Log.i("PearTubeVideo", "PearTube: local blob-server first read: bytes=$result")
      }
      result
    } catch (error: Exception) {
      Log.e(
        "PearTubeVideo",
        "PearTube: local blob-server read failed: \${error.javaClass.simpleName}: \${error.message}"
      )
      throw error
    }
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    try {
      upstream.close()
    } finally {
      if (opened) {
        Log.i("PearTubeVideo", "PearTube: local blob-server closed")
      }
      opened = false
    }
  }
}

private fun withPearTubeBlobRangeHeader(dataSpec: DataSpec): DataSpec {
  if (dataSpec.httpMethod != DataSpec.HTTP_METHOD_GET) return dataSpec
  if (dataSpec.httpRequestHeaders.containsKey("Range")) return dataSpec

  val rangeStart = dataSpec.position.coerceAtLeast(0L)
  val rangeEnd = if (dataSpec.length > 0) rangeStart + dataSpec.length - 1 else -1L
  val rangeValue = if (rangeEnd >= rangeStart) "bytes=$rangeStart-$rangeEnd" else "bytes=$rangeStart-"
  Log.i("PearTubeVideo", "${DATA_SOURCE_RANGE_MARKER}: $rangeValue")
  return dataSpec.withAdditionalHeaders(mapOf("Range" to rangeValue))
}

private fun redactPearTubeUriForLog(uri: Uri?): String {
  if (uri == null) return "null"
  val builder = uri.buildUpon().clearQuery()
  val safeParams = listOf("key", "blob", "drive", "type")
  for (name in safeParams) {
    val value = uri.getQueryParameter(name) ?: continue
    val safeValue = if (name == "type") value else value.take(16)
    builder.appendQueryParameter(name, safeValue)
  }
  if (uri.getQueryParameter("token") != null) {
    builder.appendQueryParameter("token", "redacted")
  }
  return builder.build().toString()
}
`

    if (!next.includes('fun buildPearTubeBlobDataSourceFactory(')) {
      const okHttpFactoryAnchor = /\n(@OptIn\(UnstableApi::class\)\n)?fun buildOkHttpDataSourceFactory/
      if (!okHttpFactoryAnchor.test(next)) {
        return { changed: false, source, missing: true }
      }
      next = next.replace(okHttpFactoryAnchor, `${factory}$&`)
    }
  }

  if (next.includes('private class PearTubeLoggingDataSource(') && !next.includes('withPearTubeBlobRangeHeader(dataSpec)')) {
    next = next
      .replace(
        '  override fun open(dataSpec: DataSpec): Long {\n    Log.i(',
        '  override fun open(dataSpec: DataSpec): Long {\n    val requestSpec = withPearTubeBlobRangeHeader(dataSpec)\n    Log.i(',
      )
      .replace(
        '"PearTube: local blob-server open: uri=${redactPearTubeUriForLog(dataSpec.uri)} position=${dataSpec.position} length=${dataSpec.length}"',
        '"PearTube: local blob-server open: uri=${redactPearTubeUriForLog(dataSpec.uri)} position=${dataSpec.position} length=${dataSpec.length} range=${requestSpec.httpRequestHeaders["Range"] ?: "none"}"',
      )
      .replace(
        'val result = upstream.open(dataSpec)',
        'val result = upstream.open(requestSpec)',
      )
  }

  const rangeHelper = `
private fun withPearTubeBlobRangeHeader(dataSpec: DataSpec): DataSpec {
  if (dataSpec.httpMethod != DataSpec.HTTP_METHOD_GET) return dataSpec
  if (dataSpec.httpRequestHeaders.containsKey("Range")) return dataSpec

  val rangeStart = dataSpec.position.coerceAtLeast(0L)
  val rangeEnd = if (dataSpec.length > 0) rangeStart + dataSpec.length - 1 else -1L
  val rangeValue = if (rangeEnd >= rangeStart) "bytes=$rangeStart-$rangeEnd" else "bytes=$rangeStart-"
  Log.i("PearTubeVideo", "${DATA_SOURCE_RANGE_MARKER}: $rangeValue")
  return dataSpec.withAdditionalHeaders(mapOf("Range" to rangeValue))
}
`

  if (next.includes('private class PearTubeLoggingDataSource(') && !next.includes('fun withPearTubeBlobRangeHeader(')) {
    const rangeAnchor = '\nprivate fun redactPearTubeUriForLog(uri: Uri?): String {'
    if (next.includes(rangeAnchor)) {
      next = next.replace(rangeAnchor, `${rangeHelper}${rangeAnchor}`)
    } else {
      next = `${next.trimEnd()}\n${rangeHelper}`
    }
  }

  const helper = `
private fun isPearTubeLocalBlobStream(videoSource: VideoSource): Boolean {
  val uri = videoSource.uri ?: return false
  if (uri.scheme != "http") return false
  val host = uri.host ?: return false
  if (host != "127.0.0.1" && host != "localhost" && host != "0.0.0.0" && host != "::1") return false
  return uri.getQueryParameter("key") != null || uri.getQueryParameter("blob") != null || uri.getQueryParameter("drive") != null
}
`

  if (!next.includes('fun isPearTubeLocalBlobStream(')) {
    const helperAnchor = '\nprivate fun getApplicationName(context: Context): String {'
    if (next.includes(helperAnchor)) {
      next = next.replace(helperAnchor, `${helper}${helperAnchor}`)
    } else {
      next = `${next.trimEnd()}\n${helper}`
    }
  } else {
    const helperRegex = /private fun isPearTubeLocalBlobStream\(videoSource: VideoSource\): Boolean \{\n(?: {2}.*\n)+?\}/
    if (!helperRegex.test(next)) {
      return { changed: false, source, missing: true }
    }
    next = next.replace(helperRegex, helper.trim())
  }

  next = next
    .replace(
      '"PearTube: local blob-server open: uri=${dataSpec.uri} position=${dataSpec.position} length=${dataSpec.length}"',
      '"PearTube: local blob-server open: uri=${redactPearTubeUriForLog(dataSpec.uri)} position=${dataSpec.position} length=${dataSpec.length}"',
    )
    .replace(
      '"PearTube: local blob-server opened: bytes=$result responseUri=${upstream.uri}"',
      '"PearTube: local blob-server opened: bytes=$result responseUri=${redactPearTubeUriForLog(upstream.uri)}"',
    )

  const redactionHelper = `
private fun redactPearTubeUriForLog(uri: Uri?): String {
  if (uri == null) return "null"
  val builder = uri.buildUpon().clearQuery()
  val safeParams = listOf("key", "blob", "drive", "type")
  for (name in safeParams) {
    val value = uri.getQueryParameter(name) ?: continue
    val safeValue = if (name == "type") value else value.take(16)
    builder.appendQueryParameter(name, safeValue)
  }
  if (uri.getQueryParameter("token") != null) {
    builder.appendQueryParameter("token", "redacted")
  }
  return builder.build().toString()
}
`

  if (!next.includes('fun redactPearTubeUriForLog(')) {
    const redactionAnchor = '\n@OptIn(UnstableApi::class)\nfun buildOkHttpDataSourceFactory'
    if (next.includes(redactionAnchor)) {
      next = next.replace(redactionAnchor, `${redactionHelper}${redactionAnchor}`)
    } else {
      next = `${next.trimEnd()}\n${redactionHelper}`
    }
  }

  return { changed: next !== source, source: next }
}

function patchSettingsGradleSource(source) {
  if (source.includes(EXPO_VIDEO_SOURCE_MARKER)) {
    return { changed: false, source }
  }

  const includeApp = "include ':app'\n"
  if (!source.includes(includeApp)) {
    return { changed: false, source, missing: true }
  }

  const block = `${includeApp}// ${EXPO_VIDEO_SOURCE_MARKER}.
include ':expo-video'
project(':expo-video').projectDir = new File(rootProject.projectDir, '../node_modules/expo-video/android')
`

  return {
    changed: true,
    source: source.replace(includeApp, block),
  }
}

function patchProjectBuildGradleSource(source) {
  if (source.includes(EXPO_VIDEO_SUBSTITUTION_MARKER)) {
    return { changed: false, source }
  }

  const anchor = '\napply plugin: "expo-root-project"'
  if (!source.includes(anchor)) {
    return { changed: false, source, missing: true }
  }

  const block = `
// ${EXPO_VIDEO_SUBSTITUTION_MARKER}.
subprojects {
  configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
      substitute module("host.exp.exponent:expo.modules.video") using project(":expo-video") because "PearTube patches expo-video's Android media data source for local P2P playback"
    }
  }
}
`

  return {
    changed: true,
    source: source.replace(anchor, `${block}${anchor}`),
  }
}

function withExpoVideoNotificationTap(config) {
  // Lazy require so the patch logic above stays importable for unit tests
  // without @expo/config-plugins installed.
  const { withDangerousMod, withProjectBuildGradle, withSettingsGradle } = require('@expo/config-plugins')

  config = withSettingsGradle(config, (config) => {
    const patch = patchSettingsGradleSource(config.modResults.contents)
    if (patch.missing) {
      console.warn('[withExpoVideoNotificationTap] settings.gradle app include not found; expo-video source substitution skipped.')
      return config
    }
    if (patch.changed) {
      config.modResults.contents = patch.source
      console.log('[withExpoVideoNotificationTap] Added expo-video source project to settings.gradle')
    }
    return config
  })

  config = withProjectBuildGradle(config, (config) => {
    const patch = patchProjectBuildGradleSource(config.modResults.contents)
    if (patch.missing) {
      console.warn('[withExpoVideoNotificationTap] root build.gradle plugin anchor not found; expo-video source substitution skipped.')
      return config
    }
    if (patch.changed) {
      config.modResults.contents = patch.source
      console.log('[withExpoVideoNotificationTap] Added expo-video dependency substitution to root build.gradle')
    }
    return config
  })

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

      const dataSourceFile = resolveDataSourceFile()
      if (!dataSourceFile) {
        console.warn('[withExpoVideoNotificationTap] Could not locate DataSourceUtils.kt; skipping P2P stream timeout patch')
        return config
      }
      const dataSourceOriginal = fs.readFileSync(dataSourceFile, 'utf8')
      const dataSourcePatch = patchDataSourceSource(dataSourceOriginal)
      if (dataSourcePatch.missing) {
        console.warn('[withExpoVideoNotificationTap] OkHttp data source pattern not found; expo-video may have changed. Skipping P2P stream timeout patch.')
        return config
      }
      if (dataSourcePatch.changed) {
        fs.writeFileSync(dataSourceFile, dataSourcePatch.source)
        console.log('[withExpoVideoNotificationTap] Patched DataSourceUtils.kt for local P2P stream timeouts')
      }
      return config
    },
  ])
}

module.exports = withExpoVideoNotificationTap
module.exports._patchSource = patchSource
module.exports._patchDataSourceSource = patchDataSourceSource
module.exports._patchSettingsGradleSource = patchSettingsGradleSource
module.exports._patchProjectBuildGradleSource = patchProjectBuildGradleSource
module.exports._MARKER = MARKER
module.exports._DATA_SOURCE_MARKER = DATA_SOURCE_MARKER
