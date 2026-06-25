import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../plugins/withExpoVideoNotificationTap.js')
const {
  _patchSource,
  _patchDataSourceSource,
  _patchProjectBuildGradleSource,
  _patchSettingsGradleSource,
} = plugin

// Mirrors the relevant shape of expo-video's ExpoVideoPlaybackService.kt: the
// MediaSession.Builder ends in .build(), and createNotification builds its own
// NotificationCompat (no content intent). The patch must target the NOTIFICATION
// builder's .build(), not the MediaSession builder's.
const SAMPLE = `      val mediaSession = MediaSession.Builder(this@ExpoVideoPlaybackService, player)
        .setId("ExpoVideoPlaybackService_\${player.hashCode()}")
        .setCallback(VideoMediaSessionCallback())
        .setCustomLayout(ImmutableList.of(seekBackwardButton, seekForwardButton))
        .build()

    val notificationCompat = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      .setContentTitle(contentTitle)
      .setStyle(MediaStyleNotificationHelper.MediaStyle(session))
      .build()
`

test('injects a content intent into the notification builder', () => {
  const { changed, source, missing } = _patchSource(SAMPLE)
  assert.equal(missing, undefined, 'should find the NotificationCompat.Builder')
  assert.equal(changed, true, 'should modify the source')
  assert.equal(
    (source.match(/setContentIntent/g) || []).length,
    1,
    'should add exactly one content intent',
  )
  // The content intent must sit on the NotificationCompat builder (after setStyle),
  // not on the MediaSession builder (which has no setStyle and must be untouched).
  assert.match(
    source,
    /\.setStyle\(MediaStyleNotificationHelper\.MediaStyle\(session\)\)\n\s*\.setContentIntent\(/,
  )
  assert.match(source, /getLaunchIntentForPackage\(packageName\)/)
  assert.match(source, /FLAG_IMMUTABLE/)
})

test('is idempotent — re-running does not double-patch', () => {
  const first = _patchSource(SAMPLE)
  const second = _patchSource(first.source)
  assert.equal(second.changed, false)
  assert.equal(second.source, first.source)
})

test('reports missing when the notification builder is absent', () => {
  const { changed, missing } = _patchSource('class Foo {}\n')
  assert.equal(changed, false)
  assert.equal(missing, true)
})

const DATA_SOURCE_SAMPLE = `package expo.modules.video

import android.content.Context
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import okhttp3.OkHttpClient

fun buildBaseDataSourceFactory(context: Context, videoSource: VideoSource): DataSource.Factory {
  return if (videoSource.uri?.scheme?.startsWith("http") == true) {
    buildOkHttpDataSourceFactory(context, videoSource)
  } else {
    DefaultDataSource.Factory(context)
  }
}

fun buildOkHttpDataSourceFactory(context: Context, videoSource: VideoSource): OkHttpDataSource.Factory {
  val client = OkHttpClient.Builder().build()

  return OkHttpDataSource.Factory(client)
}
`

test('configures local PearTube blob streams without an OkHttp read timeout', () => {
  assert.equal(typeof _patchDataSourceSource, 'function')

  const { changed, source, missing } = _patchDataSourceSource(DATA_SOURCE_SAMPLE)
  assert.equal(missing, undefined)
  assert.equal(changed, true)
  assert.match(source, /import android\.util\.Log/)
  assert.match(source, /import androidx\.media3\.datasource\.DefaultHttpDataSource/)
  assert.match(source, /isPearTubeLocalBlobStream\(videoSource\)/)
  assert.match(source, /buildPearTubeBlobDataSourceFactory\(context, videoSource\)/)
  assert.match(source, /DefaultHttpDataSource\.Factory\(\)/)
  assert.match(source, /setReadTimeoutMs\(0\)/)
  assert.match(source, /getQueryParameter\("key"\)/)
  assert.match(source, /getQueryParameter\("blob"\)/)
  assert.match(source, /getQueryParameter\("drive"\)/)
  assert.match(source, /host != "0\.0\.0\.0"/)
})

test('local PearTube blob stream timeout patch is idempotent', () => {
  const first = _patchDataSourceSource(DATA_SOURCE_SAMPLE)
  const second = _patchDataSourceSource(first.source)
  assert.equal(second.changed, false)
  assert.equal(second.source, first.source)
})

const SETTINGS_GRADLE_SAMPLE = `plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}

rootProject.name = 'PearTube'

include ':app'
includeBuild(expoAutolinking.reactNativeGradlePlugin)
`

test('includes expo-video as a source project so patched Kotlin is compiled', () => {
  assert.equal(typeof _patchSettingsGradleSource, 'function')

  const { changed, source, missing } = _patchSettingsGradleSource(SETTINGS_GRADLE_SAMPLE)
  assert.equal(missing, undefined)
  assert.equal(changed, true)
  assert.match(source, /PearTube: compile patched expo-video Android sources/)
  assert.match(source, /include ':expo-video'/)
  assert.match(source, /node_modules\/expo-video\/android/)

  const second = _patchSettingsGradleSource(source)
  assert.equal(second.changed, false)
  assert.equal(second.source, source)
})

const PROJECT_BUILD_GRADLE_SAMPLE = `allprojects {
  repositories {
    google()
    mavenCentral()
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`

test('substitutes the expo-video Maven artifact with the patched source project', () => {
  assert.equal(typeof _patchProjectBuildGradleSource, 'function')

  const { changed, source, missing } = _patchProjectBuildGradleSource(PROJECT_BUILD_GRADLE_SAMPLE)
  assert.equal(missing, undefined)
  assert.equal(changed, true)
  assert.match(source, /PearTube: use patched expo-video project for Android playback/)
  assert.match(source, /substitute module\("host\.exp\.exponent:expo\.modules\.video"\) using project\(":expo-video"\)/)

  const second = _patchProjectBuildGradleSource(source)
  assert.equal(second.changed, false)
  assert.equal(second.source, source)
})
