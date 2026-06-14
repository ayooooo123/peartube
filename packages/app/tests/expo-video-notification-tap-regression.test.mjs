import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../plugins/withExpoVideoNotificationTap.js')
const { _patchSource } = plugin

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
