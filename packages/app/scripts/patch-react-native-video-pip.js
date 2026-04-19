/* eslint-disable no-console, @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')

const RNV_DIR = path.join(__dirname, '..', 'node_modules', 'react-native-video', 'android', 'src', 'main', 'java', 'com', 'brentvatne')
const PIP_UTIL_PATH = path.join(RNV_DIR, 'exoplayer', 'PictureInPictureUtil.kt')
const PIP_RECEIVER_PATH = path.join(RNV_DIR, 'receiver', 'PictureInPictureReceiver.kt')

const MARKER = 'PearTube-patched'

// ─── Patch 1: PiP actions — add background audio button ───────────────────────

const PIP_ACTIONS_TARGET = [
  '    fun getPictureInPictureActions(context: ThemedReactContext, isPaused: Boolean, receiver: PictureInPictureReceiver): ArrayList<RemoteAction> {',
  '        val intent = receiver.getPipActionIntent(isPaused)',
  '        val resource =',
  '            if (isPaused) androidx.media3.ui.R.drawable.exo_icon_play else androidx.media3.ui.R.drawable.exo_icon_pause',
  '        val icon = Icon.createWithResource(context, resource)',
  '        val title = if (isPaused) "play" else "pause"',
  '        return arrayListOf(RemoteAction(icon, title, title, intent))',
  '    }',
].join('\n')

const PIP_ACTIONS_REPLACEMENT = [
  `    // ${MARKER}`,
  '    fun getPictureInPictureActions(context: ThemedReactContext, isPaused: Boolean, receiver: PictureInPictureReceiver): ArrayList<RemoteAction> {',
  '        val intent = receiver.getPipActionIntent(isPaused)',
  '        val resource =',
  '            if (isPaused) androidx.media3.ui.R.drawable.exo_icon_play else androidx.media3.ui.R.drawable.exo_icon_pause',
  '        val icon = Icon.createWithResource(context, resource)',
  '        val title = if (isPaused) "play" else "pause"',
  '        val actions = arrayListOf(RemoteAction(icon, title, title, intent))',
  '        try {',
  '            val bgResId = context.resources.getIdentifier("ic_pip_headphones", "drawable", context.packageName)',
  '            if (bgResId != 0) {',
  '                val bgIcon = Icon.createWithResource(context, bgResId)',
  '                val bgIntent = receiver.getPipBackgroundAudioIntent()',
  '                actions.add(RemoteAction(bgIcon, "Background", "Continue audio in background", bgIntent))',
  '            }',
  '        } catch (e: Exception) { /* ignore */ }',
  '        return actions',
  '    }',
].join('\n')

// ─── Patch 2: PiP close → pause unless background audio was requested ────────

const PIP_CLOSE_TARGET = [
  '            if (!info.isInPictureInPictureMode && activity.lifecycle.currentState == Lifecycle.State.CREATED) {',
  '                // when user click close button of PIP',
  '                if (!view.playInBackground) view.setPausedModifier(true)',
  '            }',
].join('\n')

const PIP_CLOSE_REPLACEMENT = [
  '            if (!info.isInPictureInPictureMode && activity.lifecycle.currentState == Lifecycle.State.CREATED) {',
  `                // ${MARKER}: pause on PiP close unless background audio was requested`,
  '                if (com.brentvatne.receiver.PictureInPictureReceiver.backgroundAudioRequested) {',
  '                    com.brentvatne.receiver.PictureInPictureReceiver.backgroundAudioRequested = false',
  '                } else {',
  '                    view.setPausedModifier(true)',
  '                    try {',
  '                        val reactContext = context as? com.facebook.react.bridge.ReactContext',
  '                            ?: (context.applicationContext as? com.facebook.react.ReactApplication)',
  '                                ?.reactHost?.currentReactContext as? com.facebook.react.bridge.ReactContext',
  '                        reactContext?.getJSModule(',
  '                            com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java',
  '                        )?.emit("onPipClosed", null)',
  '                    } catch (e: Exception) { /* ignore */ }',
  '                }',
  '            }',
].join('\n')

// ─── Patch 3: PictureInPictureReceiver — add background audio control type ───

const RECEIVER_TARGET = [
  '    companion object {',
  '        const val ACTION_MEDIA_CONTROL = "rnv_media_control"',
  '        const val EXTRA_CONTROL_TYPE = "rnv_control_type"',
  '',
  '        // The request code for play action PendingIntent.',
  '        const val REQUEST_PLAY = 1',
  '',
  '        // The request code for pause action PendingIntent.',
  '        const val REQUEST_PAUSE = 2',
  '',
  '        // The intent extra value for play action.',
  '        const val CONTROL_TYPE_PLAY = 1',
  '',
  '        // The intent extra value for pause action.',
  '        const val CONTROL_TYPE_PAUSE = 2',
  '    }',
  '',
  '    override fun onReceive(context: Context?, intent: Intent?) {',
  '        intent ?: return',
  '        if (intent.action == ACTION_MEDIA_CONTROL) {',
  '            when (intent.getIntExtra(EXTRA_CONTROL_TYPE, 0)) {',
  '                CONTROL_TYPE_PLAY -> view.setPausedModifier(false)',
  '                CONTROL_TYPE_PAUSE -> view.setPausedModifier(true)',
  '            }',
  '        }',
  '    }',
].join('\n')

const RECEIVER_REPLACEMENT = [
  '    companion object {',
  '        const val ACTION_MEDIA_CONTROL = "rnv_media_control"',
  '        const val EXTRA_CONTROL_TYPE = "rnv_control_type"',
  '',
  '        const val REQUEST_PLAY = 1',
  '        const val REQUEST_PAUSE = 2',
  `        const val REQUEST_BACKGROUND_AUDIO = 3 // ${MARKER}`,
  '',
  '        const val CONTROL_TYPE_PLAY = 1',
  '        const val CONTROL_TYPE_PAUSE = 2',
  `        const val CONTROL_TYPE_BACKGROUND_AUDIO = 3 // ${MARKER}`,
  '',
  `        // ${MARKER}: flag to tell PiP close handler to skip pause`,
  '        @JvmStatic @Volatile',
  '        var backgroundAudioRequested = false',
  '    }',
  '',
  '    override fun onReceive(context: Context?, intent: Intent?) {',
  '        intent ?: return',
  '        if (intent.action == ACTION_MEDIA_CONTROL) {',
  '            when (intent.getIntExtra(EXTRA_CONTROL_TYPE, 0)) {',
  '                CONTROL_TYPE_PLAY -> view.setPausedModifier(false)',
  '                CONTROL_TYPE_PAUSE -> view.setPausedModifier(true)',
  '                CONTROL_TYPE_BACKGROUND_AUDIO -> {',
  `                    // ${MARKER}: set flag so close handler skips pause, then move to background`,
  '                    backgroundAudioRequested = true',
  '                    try {',
  '                        val activity = this@PictureInPictureReceiver.context.currentActivity',
  '                        activity?.moveTaskToBack(true)',
  '                    } catch (e: Exception) {',
  '                        android.util.Log.w("PipReceiver", "Failed to move to background", e)',
  '                    }',
  '                }',
  '            }',
  '        }',
  '    }',
].join('\n')

// ─── Patch 4: Add getPipBackgroundAudioIntent to receiver ─────────────────────

const RECEIVER_INTENT_TARGET = '    fun getPipActionIntent(isPaused: Boolean): PendingIntent {'

const RECEIVER_INTENT_REPLACEMENT = [
  `    // ${MARKER}`,
  '    fun getPipBackgroundAudioIntent(): PendingIntent {',
  '        val flag =',
  '            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {',
  '                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE',
  '            } else {',
  '                PendingIntent.FLAG_UPDATE_CURRENT',
  '            }',
  '        val intent = Intent(ACTION_MEDIA_CONTROL).putExtra(EXTRA_CONTROL_TYPE, CONTROL_TYPE_BACKGROUND_AUDIO)',
  '        intent.setPackage(context.packageName)',
  '        return PendingIntent.getBroadcast(context, REQUEST_BACKGROUND_AUDIO, intent, flag)',
  '    }',
  '',
  '    fun getPipActionIntent(isPaused: Boolean): PendingIntent {',
].join('\n')

// ─── Patch 5: Enable extension renderers for NextLib FFmpeg decoders ──────────

const EXOPLAYER_VIEW_PATH = path.join(RNV_DIR, 'exoplayer', 'ReactExoplayerView.java')

const RENDERER_MODE_TARGET = '.setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)'

const RENDERER_MODE_REPLACEMENT = `.setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER) // ${MARKER}`

// ─── Patch 6: Guard seek callbacks during player teardown ─────────────────────

const SEEK_BUFFER_TARGET = [
  '        if (isPaused && isSeeking && !buffering) {',
  '            eventEmitter.onVideoSeek.invoke(player.getCurrentPosition(), seekPosition);',
  '            isSeeking = false;',
  '        }',
].join('\n')

const SEEK_BUFFER_REPLACEMENT = [
  `        // ${MARKER}: avoid seek callback crashes after native player teardown`,
  '        if (isPaused && isSeeking && !buffering && player != null) {',
  '            eventEmitter.onVideoSeek.invoke(player.getCurrentPosition(), seekPosition);',
  '            isSeeking = false;',
  '        }',
].join('\n')

const SEEK_PLAYING_TARGET = [
  '        if (isPlaying && isSeeking) {',
  '            eventEmitter.onVideoSeek.invoke(player.getCurrentPosition(), seekPosition);',
  '        }',
].join('\n')

const SEEK_PLAYING_REPLACEMENT = [
  `        // ${MARKER}: avoid seek callback crashes after native player teardown`,
  '        if (isPlaying && isSeeking && player != null) {',
  '            eventEmitter.onVideoSeek.invoke(player.getCurrentPosition(), seekPosition);',
  '        }',
].join('\n')

const UPDATE_RESUME_TARGET = [
  '    private void updateResumePosition() {',
  '        resumeWindow = player.getCurrentMediaItemIndex();',
  '        resumePosition = player.isCurrentMediaItemSeekable() ? Math.max(0, player.getCurrentPosition())',
  '                : C.TIME_UNSET;',
  '    }',
].join('\n')

const UPDATE_RESUME_REPLACEMENT = [
  '    private void updateResumePosition() {',
  `        // ${MARKER}: player callbacks can race release`,
  '        if (player == null) {',
  '            resumeWindow = C.INDEX_UNSET;',
  '            resumePosition = C.TIME_UNSET;',
  '            return;',
  '        }',
  '        resumeWindow = player.getCurrentMediaItemIndex();',
  '        resumePosition = player.isCurrentMediaItemSeekable() ? Math.max(0, player.getCurrentPosition())',
  '                : C.TIME_UNSET;',
  '    }',
].join('\n')

const RELEASE_PLAYER_TARGET = [
  '            updateResumePosition();',
  '            player.release();',
  '            player.removeListener(this);',
].join('\n')

const RELEASE_PLAYER_REPLACEMENT = [
  '            updateResumePosition();',
  `            // ${MARKER}: stop callbacks before the native player begins tearing down`,
  '            player.removeListener(this);',
  '            player.release();',
].join('\n')

// ─── Apply ────────────────────────────────────────────────────────────────────

function applyPatch(filePath, target, replacement, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}: file not found: ${filePath}`)
  }
  const source = fs.readFileSync(filePath, 'utf8')
  if (source.includes(replacement)) {
    console.log(`${label}: already patched.`)
    return false
  }
  if (!source.includes(target)) {
    throw new Error(`${label}: target block not found`)
  }
  fs.writeFileSync(filePath, source.replace(target, replacement))
  console.log(`${label}: patched.`)
  return true
}

function applyAllPatches() {
  let changed = false
  changed = applyPatch(PIP_UTIL_PATH, PIP_ACTIONS_TARGET, PIP_ACTIONS_REPLACEMENT, 'PiP actions') || changed
  changed = applyPatch(PIP_UTIL_PATH, PIP_CLOSE_TARGET, PIP_CLOSE_REPLACEMENT, 'PiP close pause') || changed
  changed = applyPatch(PIP_RECEIVER_PATH, RECEIVER_TARGET, RECEIVER_REPLACEMENT, 'PiP receiver') || changed
  changed = applyPatch(PIP_RECEIVER_PATH, RECEIVER_INTENT_TARGET, RECEIVER_INTENT_REPLACEMENT, 'PiP receiver intent') || changed
  changed = applyPatch(EXOPLAYER_VIEW_PATH, RENDERER_MODE_TARGET, RENDERER_MODE_REPLACEMENT, 'Extension renderers') || changed
  changed = applyPatch(EXOPLAYER_VIEW_PATH, SEEK_BUFFER_TARGET, SEEK_BUFFER_REPLACEMENT, 'Seek buffer callback guard') || changed
  changed = applyPatch(EXOPLAYER_VIEW_PATH, SEEK_PLAYING_TARGET, SEEK_PLAYING_REPLACEMENT, 'Seek playing callback guard') || changed
  changed = applyPatch(EXOPLAYER_VIEW_PATH, UPDATE_RESUME_TARGET, UPDATE_RESUME_REPLACEMENT, 'Resume position guard') || changed
  changed = applyPatch(EXOPLAYER_VIEW_PATH, RELEASE_PLAYER_TARGET, RELEASE_PLAYER_REPLACEMENT, 'Release listener ordering') || changed
  return changed
}

if (require.main === module) {
  applyAllPatches()
}

module.exports = { applyAllPatches }
