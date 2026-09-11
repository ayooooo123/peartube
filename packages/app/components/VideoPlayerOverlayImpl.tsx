import React, { useCallback, useContext, useEffect, useState, useRef, useMemo } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Platform, ScrollView, ActivityIndicator, Alert, Dimensions, TextInput, AppState } from 'react-native'
import { usePathname, useSegments } from 'expo-router'
import { rpc } from '@peartube/platform/rpc'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { usePlatform } from '@/lib/PlatformProvider'
import { useSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from './desktop/constants'
import { useApp } from '@/lib/AppContext'
import type { VideoData, VideoStats } from '@peartube/core'


import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  runOnJS,
  Extrapolation,
  cancelAnimation,
} from 'react-native-reanimated'
import { Feather as ExpoFeather, Ionicons as ExpoIonicons } from '@expo/vector-icons'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { useChannelMetaName } from '@/lib/useChannelMetaName'
import { useCastBufferingDebounced } from '@/lib/useCastBufferingDebounced'
import { useControlVisibilityTimers } from '@/lib/useControlVisibilityTimers'
import { useScrubberSeekSync } from '@/lib/useScrubberSeekSync'
import { useLandscapeScreenDimensions } from '@/lib/useLandscapeScreenDimensions'
import { useDownloads } from '@/lib/DownloadsContext'
import { useCurrentDownloadStatus } from '@/hooks/useCurrentDownloadStatus'
import { useSocial } from '@/lib/SocialContext'
import { colors } from '@/lib/colors'
import { getPlayerPageVideoHeight } from '@/lib/video-layout'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { useCast } from '@/lib/cast'
import { DevicePickerModal } from '@/components/cast'
import { useMiniPlayerPosition, useLandscapeMode } from './video-player/hooks'
import {
  computeMiniSize,
  computeMiniBounds,
  getCornerAnchors,
  getMobileMiniPlayerSnapPosition,
  resolveSnapTarget,
  type MiniBounds,
  type MiniPlayerCorner,
  type Anchor,
} from './video-player/overlayDerivedState'

// Import modular video-player components
import {
  // Constants
  MINI_PIP_MARGIN,
  MINI_PIP_CORNER_RADIUS,
  TAB_BAR_HEIGHT,

  SPRING_CONFIG_BOUNCY,
  SPRING_CONFIG_TIGHT,
  SPRING_CONFIG_MINI_SNAP,
  MINI_DRAG_SCALE,
  MINI_SHADOW_DOCKED,
  MINI_SHADOW_DRAGGING,
  MINI_DRAG_OVERSHOOT_X,
  MINI_DRAG_OVERSHOOT_TOP,
  MINI_DRAG_OVERSHOOT_BOTTOM,
  DESKTOP_MINI_WIDTH,
  DESKTOP_MINI_HEIGHT,
  DESKTOP_MINI_CONTROLS_HEIGHT,
  PLAYBACK_SPEEDS,
  SEEK_STEP_SECONDS,
  // Formatters
  formatSize,
  formatSizeLabel,
  formatTimeAgo,
  formatDuration,
  // Styles
  styles,
  desktopStyles,
  // Components
  P2PStatsBar,
  ChannelInfo,
  ActionButton,
  ReactionButton,
  Scrubber,
  PearInlineVideoView,
} from './video-player'
import type { PlayerPort } from '@/lib/video-player'

type PlayerProgressHandler = (data: { currentTime: number; duration: number }) => void
type PlayerBufferingHandler = (data: { isBuffering: boolean }) => void
type PlayerVideoStateHandler = (data: {
  type?: string
  mVideoWidth?: number
  mVideoHeight?: number
}) => void
type AnimatedViewStyle = React.ComponentProps<typeof Animated.View>['style']

function readStatNumber(
  videoStats: VideoStats | null | undefined,
  key: keyof VideoStats,
  fallback = 0,
): number {
  const value = videoStats == null ? fallback : videoStats[key]
  return Number(value ?? fallback)
}

function resolveDesktopP2PStatus(videoStats: VideoStats | null | undefined) {
  if (videoStats?.isComplete === true) {
    return { isComplete: true as const, statusColor: '#4ade80', statusLabel: 'Cached' }
  }
  if (videoStats?.status === 'downloading') {
    return { isComplete: false as const, statusColor: '#fbbf24', statusLabel: 'Downloading' }
  }
  return { isComplete: false as const, statusColor: '#6b7280', statusLabel: 'Connecting' }
}

function showCastAlert(message: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message)
    return
  }
  Alert.alert('Chromecast', message)
}

// Use the real @expo/vector-icons components on all platforms.
// The font files are linked into Android assets by the withVectorIconFonts plugin.
const Feather = ExpoFeather
const Ionicons = ExpoIonicons

const ZERO_EDGE_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
// ── Responsive mini-player geometry helpers live in ./video-player/overlayDerivedState ──
function resolveStableInsets(
  insets: { top: number; bottom: number },
  isAndroid: boolean,
  isWindowLandscape: boolean,
  lastNonZeroInsetTopRef: { current: number },
  lastNonZeroInsetBottomRef: { current: number },
  stableInsetTopRef: { current: number },
  stableInsetBottomRef: { current: number },
  isAndroidFullscreenPipTransition: boolean,
) {
  if (isAndroid && !isWindowLandscape) {
    if (insets.top > 0) lastNonZeroInsetTopRef.current = insets.top
    if (insets.bottom > 0) lastNonZeroInsetBottomRef.current = insets.bottom
  }

  const resolvedInsetTop = (isAndroid && !isWindowLandscape && insets.top === 0 && lastNonZeroInsetTopRef.current > 0)
    ? lastNonZeroInsetTopRef.current
    : insets.top

  const resolvedInsetBottom = (isAndroid && !isWindowLandscape && insets.bottom === 0 && lastNonZeroInsetBottomRef.current > 0)
    ? lastNonZeroInsetBottomRef.current
    : insets.bottom

  if (!isAndroidFullscreenPipTransition) {
    stableInsetTopRef.current = resolvedInsetTop
    stableInsetBottomRef.current = resolvedInsetBottom
  } else {
    if (resolvedInsetTop > stableInsetTopRef.current) stableInsetTopRef.current = resolvedInsetTop
    if (resolvedInsetBottom > stableInsetBottomRef.current) stableInsetBottomRef.current = resolvedInsetBottom
  }
}

function computePipLayoutActive({
  isAndroid,
  playerMode,
  isInPipMode,
  pipModePrevRef,
  pipExitBlockEarlyDetectRef,
  windowWidth,
  windowHeight,
  screenMetrics,
}: {
  isAndroid: boolean
  playerMode: string
  isInPipMode: boolean
  pipModePrevRef: { current: boolean }
  pipExitBlockEarlyDetectRef: { current: boolean }
  windowWidth: number
  windowHeight: number
  screenMetrics: { width: number; height: number }
}): boolean {
  const prevIsInPipMode = pipModePrevRef.current
  pipModePrevRef.current = isInPipMode

  const isAndroidFullscreenForPip = isAndroid && playerMode === 'fullscreen'
  const isWindowShrunkForPip = isAndroidFullscreenForPip
    && windowWidth < screenMetrics.width * 0.9
    && windowHeight < screenMetrics.height * 0.9

  if (isAndroidFullscreenForPip) {
    if (!prevIsInPipMode && isInPipMode) {
      pipExitBlockEarlyDetectRef.current = false
    } else if (prevIsInPipMode && !isInPipMode) {
      pipExitBlockEarlyDetectRef.current = true
    } else if (pipExitBlockEarlyDetectRef.current && !isWindowShrunkForPip) {
      pipExitBlockEarlyDetectRef.current = false
    }
  } else {
    pipExitBlockEarlyDetectRef.current = false
  }

  return isInPipMode || (!pipExitBlockEarlyDetectRef.current && isWindowShrunkForPip)
}

function resolveAndroidFullscreenPipTransition(
  playerMode: string,
  isInPipMode: boolean,
  windowWidth: number,
  windowHeight: number,
  screenMetrics: { width: number; height: number },
): boolean {
  if (Platform.OS !== 'android' || playerMode !== 'fullscreen') return false
  return isInPipMode || (
    windowWidth < screenMetrics.width * 0.9
    && windowHeight < screenMetrics.height * 0.9
  )
}

function updateFrozenLayoutValues(
  isPipLayoutActive: boolean,
  videoHeight: number,
  stableInsetTopRef: { current: number },
  stableInsetBottomRef: { current: number },
  frozenVideoHeight: { value: number },
  frozenInsetTop: { value: number },
  frozenInsetBottom: { value: number },
): void {
  if (isPipLayoutActive) return
  frozenVideoHeight.value = videoHeight
  if (stableInsetTopRef.current > 0 || frozenInsetTop.value === 0) {
    frozenInsetTop.value = stableInsetTopRef.current
  }
  if (stableInsetBottomRef.current > 0 || frozenInsetBottom.value === 0) {
    frozenInsetBottom.value = stableInsetBottomRef.current
  }
}

function resolveDesktopP2PPresentation(videoStats: VideoStats | null | undefined) {
  const status = resolveDesktopP2PStatus(videoStats)
  return {
    ...status,
    speed: readStatNumber(videoStats, 'speedMBps').toFixed(2),
    uploadSpeed: readStatNumber(videoStats, 'uploadSpeedMBps').toFixed(2),
    peerCount: readStatNumber(videoStats, 'peerCount'),
    downloadedBytes: readStatNumber(videoStats, 'downloadedBytes'),
    totalBytes: readStatNumber(videoStats, 'totalBytes'),
    downloadedBlocks: readStatNumber(videoStats, 'downloadedBlocks'),
    totalBlocks: readStatNumber(videoStats, 'totalBlocks'),
    progress: readStatNumber(videoStats, 'progress'),
  }
}

function DesktopP2PStats({ videoStats }: { videoStats: VideoStats | null | undefined }) {
  const stats = resolveDesktopP2PPresentation(videoStats)

  return (
    <div style={desktopStyles.p2pStatsBar}>
      <div style={desktopStyles.p2pStatsRow}>
        <div style={desktopStyles.p2pStatItem}>
          <div style={{ ...desktopStyles.statusDot, backgroundColor: stats.statusColor }} />
          <span style={{ ...desktopStyles.statusLabel, color: stats.statusColor }}>{stats.statusLabel}</span>
        </div>
        <span style={desktopStyles.p2pStatText}>{stats.peerCount} peers</span>
        <span style={desktopStyles.p2pStatSpeed}>↓ {stats.speed} MB/s</span>
        <span style={desktopStyles.p2pStatSpeedUp}>↑ {stats.uploadSpeed} MB/s</span>
      </div>
      <div style={desktopStyles.p2pStatsRowSecondary}>
        <span style={desktopStyles.p2pStatDetail}>
          {formatSize(stats.downloadedBytes)} / {formatSize(stats.totalBytes)}
        </span>
        <span style={desktopStyles.p2pStatDetail}>
          {stats.downloadedBlocks} / {stats.totalBlocks} blocks
        </span>
        <span style={{ ...desktopStyles.p2pStatProgress, color: stats.isComplete ? '#4ade80' : colors.text }}>
          {stats.progress}%
        </span>
      </div>
    </div>
  )
}
type DesktopMiniPlayerViewProps = {
  currentVideo: VideoData
  videoUrl: string | null
  playerRef: { current: PlayerPort | null }
  playbackSession: number
  isPlaying: boolean
  playbackRate: number
  playerSeekPosition: number | undefined
  handleVideoLoad: (info: { duration?: number; videoSize?: { width: number; height: number } }) => void
  onProgress: PlayerProgressHandler
  onPlaying: () => void
  onPaused: () => void
  onBuffering: PlayerBufferingHandler
  onEnded: () => void
  onError: (err: unknown) => void
  onVideoStateChange: PlayerVideoStateHandler
  isCasting: boolean
  effectiveIsPlaying: boolean
  handlePlayPause: () => void
  effectiveProgress: number
  maximizeFromMini: () => void
  channelName: string
  desktopMiniPlayerPosition: { x: number; y: number }
  isDraggingDesktopMiniPlayer: boolean
  handleMiniPlayerDragStart: (event: React.MouseEvent) => void
  closeVideo: () => void
}

function DesktopMiniPlayerView({
  currentVideo,
  videoUrl,
  playerRef,
  playbackSession,
  isPlaying,
  playbackRate,
  playerSeekPosition,
  handleVideoLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  isCasting,
  effectiveIsPlaying,
  handlePlayPause,
  effectiveProgress,
  maximizeFromMini,
  channelName,
  desktopMiniPlayerPosition,
  isDraggingDesktopMiniPlayer,
  handleMiniPlayerDragStart,
  closeVideo,
}: DesktopMiniPlayerViewProps) {
  const miniPos = desktopMiniPlayerPosition

  return (
    <div
      style={{
        position: 'fixed',
        left: miniPos.x,
        top: miniPos.y,
        width: DESKTOP_MINI_WIDTH,
        zIndex: 9999,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: colors.bg,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
        border: `1px solid ${colors.border}`,
        cursor: isDraggingDesktopMiniPlayer ? 'grabbing' : 'default',
        userSelect: 'none',
        transition: isDraggingDesktopMiniPlayer ? 'none' : 'left 0.2s ease, top 0.2s ease',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Move mini player"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 32,
          cursor: isDraggingDesktopMiniPlayer ? 'grabbing' : 'grab',
          zIndex: 10,
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            maximizeFromMini()
          }
        }}
        onMouseDown={handleMiniPlayerDragStart}
      />

      <div
        style={{
          width: DESKTOP_MINI_WIDTH,
          height: DESKTOP_MINI_HEIGHT,
          backgroundColor: '#000',
          position: 'relative',
        }}
      >
        {isCasting ? (
          <div style={{ ...desktopStyles.castPlaceholder, height: DESKTOP_MINI_HEIGHT }}>
            <Feather name="cast" color={colors.primary} size={24} />
            <span style={{ fontSize: 12, color: colors.textMuted }}>Casting...</span>
          </div>
        ) : videoUrl ? (
          <PearInlineVideoView
            style={StyleSheet.absoluteFill}
            playerRef={playerRef}
            videoUrl={videoUrl}
            playbackSession={playbackSession}
            currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            seekPosition={playerSeekPosition}
            videoTitle={currentVideo?.title}
            channelName={currentVideo?.channel?.name}
            thumbnailUrl={currentVideo?.thumbnailUrl}
            onLoad={handleVideoLoad}
            onProgress={onProgress}
            onPlaying={onPlaying}
            onPaused={onPaused}
            onBuffering={onBuffering}
            onEnded={onEnded}
            onError={onError}
            onVideoStateChange={onVideoStateChange}
          />
        ) : (
          <div style={{ ...desktopStyles.placeholder, height: DESKTOP_MINI_HEIGHT }}>
            <span style={{ fontSize: 32, color: colors.primary, fontWeight: '600' }}>
              {currentVideo.title.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-label={effectiveIsPlaying ? 'Pause video' : 'Play video'}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            opacity: 0,
            transition: 'opacity 0.15s ease',
          }}
          className="mini-player-overlay"
          onClick={handlePlayPause}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              handlePlayPause()
            }
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            {effectiveIsPlaying ? (
              <Ionicons name="pause" color="#fff" size={24} />
            ) : (
              <Ionicons name="play" color="#fff" size={24} />
            )}
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${effectiveProgress * 100}%`,
              backgroundColor: colors.primary,
              transition: 'width 0.1s linear',
            }}
          />
        </div>
      </div>

      <div
        style={{
          height: DESKTOP_MINI_CONTROLS_HEIGHT,
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          backgroundColor: colors.bgSecondary,
        }}
      >
        <div
          role="button"
          tabIndex={0}
          style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
          onClick={maximizeFromMini}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              maximizeFromMini()
            }
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: '500',
              color: colors.text,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {currentVideo.title}
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {channelName}
          </div>
        </div>

        <button
          type="button"
          onClick={handlePlayPause}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            border: 'none',
            backgroundColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          {effectiveIsPlaying ? (
            <Ionicons name="pause" color={colors.text} size={18} />
          ) : (
            <Ionicons name="play" color={colors.text} size={18} />
          )}
        </button>

        <button
          type="button"
          onClick={maximizeFromMini}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            border: 'none',
            backgroundColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          title="Expand"
        >
          <Feather name="chevron-up" color={colors.text} size={18} />
        </button>

        <button
          type="button"
          onClick={closeVideo}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            border: 'none',
            backgroundColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          title="Close"
        >
          <Feather name="x" color={colors.text} size={18} />
        </button>
      </div>

      <style>{`
        .mini-player-overlay:hover {
          opacity: 1 !important;
        }
      `}</style>
    </div>
  )
}

type DesktopVideoStageProps = {
  desktopVideoWidth: number
  desktopVideoHeight: number
  isCasting: boolean
  castDeviceName: string
  currentVideo: VideoData
  videoUrl: string | null
  playerRef: { current: PlayerPort | null }
  playbackSession: number
  isPlaying: boolean
  playbackRate: number
  playerSeekPosition: number | undefined
  handleVideoLoad: (info: { duration?: number; videoSize?: { width: number; height: number } }) => void
  onProgress: PlayerProgressHandler
  onPlaying: () => void
  onPaused: () => void
  onBuffering: PlayerBufferingHandler
  onEnded: () => void
  onError: (err: unknown) => void
  onVideoStateChange: PlayerVideoStateHandler
  showLoadingOverlay: boolean
  terminalPlaybackError: { message: string } | null
  loadingLabel: string
}

function DesktopVideoStage({
  desktopVideoWidth,
  desktopVideoHeight,
  isCasting,
  castDeviceName,
  currentVideo,
  videoUrl,
  playerRef,
  playbackSession,
  isPlaying,
  playbackRate,
  playerSeekPosition,
  handleVideoLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  showLoadingOverlay,
  terminalPlaybackError,
  loadingLabel,
}: DesktopVideoStageProps) {
  let stageBody: React.ReactNode
  if (isCasting) {
    stageBody = (
      <div style={desktopStyles.castPlaceholder}>
        <Feather name="cast" color={colors.primary} size={40} />
        <div style={desktopStyles.castTextBlock}>
          <span style={desktopStyles.castTitle}>Casting to {castDeviceName}</span>
          <span style={desktopStyles.castSubtitle}>{currentVideo.title}</span>
        </div>
      </div>
    )
  } else if (videoUrl) {
    stageBody = (
      <PearInlineVideoView
        style={[StyleSheet.absoluteFill, { borderRadius: 12 }]}
        playerRef={playerRef}
        videoUrl={videoUrl}
        playbackSession={playbackSession}
        currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        seekPosition={playerSeekPosition}
        videoTitle={currentVideo?.title}
        channelName={currentVideo?.channel?.name}
        thumbnailUrl={currentVideo?.thumbnailUrl}
        onLoad={handleVideoLoad}
        onProgress={onProgress}
        onPlaying={onPlaying}
        onPaused={onPaused}
        onBuffering={onBuffering}
        onEnded={onEnded}
        onError={onError}
        onVideoStateChange={onVideoStateChange}
      />
    )
  } else {
    stageBody = (
      <div style={desktopStyles.placeholder}>
        <span style={desktopStyles.placeholderText}>{currentVideo.title.charAt(0).toUpperCase()}</span>
      </div>
    )
  }

  return (
    <div style={{ ...desktopStyles.videoWrapper, width: desktopVideoWidth, height: desktopVideoHeight }}>
      {stageBody}
      {showLoadingOverlay ? (
        <div style={desktopStyles.loadingOverlay}>
          {!terminalPlaybackError && <ActivityIndicator color="white" size="large" />}
          <Text style={{ color: '#fff', marginTop: 12 }}>{loadingLabel}</Text>
        </div>
      ) : null}
    </div>
  )
}

type DesktopPlaybackBarProps = {
  handlePlayPause: () => void
  effectiveIsPlaying: boolean
  effectiveDuration: number
  isSeeking: boolean
  seekPosition: number
  effectiveCurrentTime: number
  handleDesktopSeekStart: (event: React.MouseEvent | React.TouchEvent) => void
  handleDesktopSeekEnd: (event: React.MouseEvent | React.TouchEvent) => void
  handleDesktopSeekChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}

function DesktopPlaybackBar({
  handlePlayPause,
  effectiveIsPlaying,
  effectiveDuration,
  isSeeking,
  seekPosition,
  effectiveCurrentTime,
  handleDesktopSeekStart,
  handleDesktopSeekEnd,
  handleDesktopSeekChange,
}: DesktopPlaybackBarProps) {
  return (
    <div style={desktopStyles.playerControls}>
      <button type="button" onClick={handlePlayPause} style={desktopStyles.controlButton} aria-label={effectiveIsPlaying ? 'Pause' : 'Play'}>
        <Feather name={effectiveIsPlaying ? 'pause' : 'play'} color={colors.text} size={16} />
      </button>
      <div style={desktopStyles.seekRow}>
        <input
          type="range"
          min={0}
          max={effectiveDuration || 0}
          step={0.1}
          value={isSeeking ? seekPosition : effectiveCurrentTime}
          disabled={effectiveDuration <= 0}
          onMouseDown={handleDesktopSeekStart}
          onTouchStart={handleDesktopSeekStart}
          onChange={handleDesktopSeekChange}
          onMouseUp={handleDesktopSeekEnd}
          onTouchEnd={handleDesktopSeekEnd}
          style={desktopStyles.seekInput}
        />
        <span style={desktopStyles.timeLabel}>
          {formatDuration(isSeeking ? seekPosition : effectiveCurrentTime)} / {formatDuration(effectiveDuration)}
        </span>
      </div>
    </div>
  )
}

type DesktopReactionActionsProps = {
  toggleReaction: (type: string) => void
  userReaction: string | null
  reactionCounts: Record<string, number>
  isDownloaded: boolean
  handleDownload: () => void
  isDownloading: boolean
}

function DesktopReactionActions({
  toggleReaction,
  userReaction,
  reactionCounts,
  isDownloaded,
  handleDownload,
  isDownloading,
}: DesktopReactionActionsProps) {
  return (
    <div style={desktopStyles.actions}>
      <button
        type="button"
        onClick={() => toggleReaction('like')}
        style={{
          ...desktopStyles.reactionButton,
          backgroundColor: userReaction === 'like' ? colors.primary : colors.bgSecondary,
        }}
      >
        <span style={{ color: userReaction === 'like' ? '#fff' : colors.text }}>
          Like ({reactionCounts.like || 0})
        </span>
      </button>
      <button
        type="button"
        onClick={() => toggleReaction('dislike')}
        style={{
          ...desktopStyles.reactionButton,
          backgroundColor: userReaction === 'dislike' ? colors.textSecondary : colors.bgSecondary,
        }}
      >
        <span style={{ color: userReaction === 'dislike' ? '#fff' : colors.text }}>
          Dislike ({reactionCounts.dislike || 0})
        </span>
      </button>
      <button
        type="button"
        onClick={isDownloaded ? undefined : handleDownload}
        disabled={isDownloaded || isDownloading}
        style={{
          ...desktopStyles.actionButton,
          opacity: isDownloaded ? 0.7 : 1,
          cursor: isDownloaded ? 'default' : 'pointer',
        }}
      >
        <Feather name={isDownloaded ? 'check' : 'download'} color={isDownloaded ? colors.primary : colors.text} size={18} />
        <span style={desktopStyles.actionLabel}>
          {isDownloaded ? 'Downloaded' : isDownloading ? 'Downloading...' : 'Download'}
        </span>
      </button>
    </div>
  )
}

type DesktopCommentsPanelProps = {
  displayComments: Array<unknown>
  refreshComments: () => void
  refreshingComments: boolean
  commentText: string
  setCommentText: (text: string) => void
  postComment: () => void
  postingComment: boolean
  commentsLoading: boolean
  organizedComments: Array<Record<string, unknown>>
}

function DesktopCommentEntry({ comment }: { comment: Record<string, unknown> }) {
  const replies = Array.isArray(comment.replies) ? (comment.replies as Array<Record<string, unknown>>) : []
  return (
    <div key={String(comment.commentId || '')} style={desktopStyles.commentItem}>
      <div style={desktopStyles.commentHeader}>
        <span style={desktopStyles.commentAuthor}>
          {String(comment.authorKeyHex || '').slice(0, 12)}…
        </span>
        <span style={desktopStyles.commentTime}>
          {formatTimeAgo(typeof comment.timestamp === 'number' ? comment.timestamp : Date.now())}
        </span>
        {Boolean(comment.isAdmin) && <span style={desktopStyles.adminBadge}>Admin</span>}
      </div>
      <p style={desktopStyles.commentText}>{String(comment.content || comment.text || '')}</p>
      {replies.length > 0 ? (
        <div style={desktopStyles.replies}>
          {replies.map((reply) => (
            <div key={String(reply.commentId || '')} style={desktopStyles.replyItem}>
              <span style={desktopStyles.commentAuthor}>{String(reply.authorKeyHex || '').slice(0, 12)}…</span>
              <p style={desktopStyles.commentText}>{String(reply.content || reply.text || '')}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function DesktopCommentsPanel({
  displayComments,
  refreshComments,
  refreshingComments,
  commentText,
  setCommentText,
  postComment,
  postingComment,
  commentsLoading,
  organizedComments,
}: DesktopCommentsPanelProps) {
  let commentsBody: React.ReactNode
  if (commentsLoading && displayComments.length === 0) {
    commentsBody = (
      <div style={{ padding: 20, textAlign: 'center' as const }}>
        <ActivityIndicator color={colors.primary} />
      </div>
    )
  } else if (displayComments.length === 0) {
    commentsBody = <p style={desktopStyles.noComments}>No comments yet. Be the first to comment!</p>
  } else {
    commentsBody = organizedComments.map((comment) => (
      <DesktopCommentEntry key={String(comment.commentId || '')} comment={comment} />
    ))
  }

  return (
    <div style={desktopStyles.commentsSection}>
      <div style={desktopStyles.commentsHeader}>
        <h3 style={desktopStyles.commentsTitle}>
          {displayComments.length > 0 ? `${displayComments.length} Comment${displayComments.length !== 1 ? 's' : ''}` : 'Comments'}
        </h3>
        <button type="button" onClick={refreshComments} disabled={refreshingComments} style={desktopStyles.refreshButton}>
          <Feather name="rotate-ccw" color={colors.primary} size={14} />
          <span>{refreshingComments ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </div>

      <div style={desktopStyles.commentComposer}>
        <input
          type="text"
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          placeholder="Add a comment..."
          style={desktopStyles.commentInput}
          onKeyDown={(e) => { if (e.key === 'Enter' && commentText.trim()) postComment() }}
        />
        <button
          type="button"
          onClick={postComment}
          disabled={postingComment || !commentText.trim()}
          style={{ ...desktopStyles.postButton, opacity: (postingComment || !commentText.trim()) ? 0.5 : 1 }}
        >
          {postingComment ? 'Posting...' : 'Post'}
        </button>
      </div>

      <div style={desktopStyles.commentsList}>{commentsBody}</div>
    </div>
  )
}

type DesktopOverlayViewProps = {
  sidebarWidth: number
  desktopVideoWidth: number
  desktopVideoHeight: number
  isCasting: boolean
  castDeviceName: string
  currentVideo: VideoData
  videoUrl: string | null
  playerRef: { current: PlayerPort | null }
  playbackSession: number
  isPlaying: boolean
  playbackRate: number
  playerSeekPosition: number | undefined
  handleVideoLoad: (info: { duration?: number; videoSize?: { width: number; height: number } }) => void
  onProgress: PlayerProgressHandler
  onPlaying: () => void
  onPaused: () => void
  onBuffering: PlayerBufferingHandler
  onEnded: () => void
  onError: (err: unknown) => void
  onVideoStateChange: PlayerVideoStateHandler
  showLoadingOverlay: boolean
  terminalPlaybackError: { message: string } | null
  loadingLabel: string
  handlePlayPause: () => void
  effectiveIsPlaying: boolean
  effectiveDuration: number
  isSeeking: boolean
  seekPosition: number
  effectiveCurrentTime: number
  handleDesktopSeekStart: (event: React.MouseEvent | React.TouchEvent) => void
  handleDesktopSeekEnd: (event: React.MouseEvent | React.TouchEvent) => void
  handleDesktopSeekChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  handleCastDisconnect: () => void
  videoStats: VideoStats | null | undefined
  sizeLabel: string | null
  channelInitial: string
  channelName: string
  toggleReaction: (type: string) => void
  userReaction: string | null
  reactionCounts: Record<string, number>
  isDownloaded: boolean
  handleDownload: () => void
  isDownloading: boolean
  displayComments: Array<unknown>
  refreshComments: () => void
  refreshingComments: boolean
  commentText: string
  setCommentText: (text: string) => void
  postComment: () => void
  postingComment: boolean
  commentsLoading: boolean
  organizedComments: Array<Record<string, unknown>>
  minimizePlayer: () => void
  closeVideo: () => void
}

function DesktopOverlayView({
  sidebarWidth,
  desktopVideoWidth,
  desktopVideoHeight,
  isCasting,
  castDeviceName,
  currentVideo,
  videoUrl,
  playerRef,
  playbackSession,
  isPlaying,
  playbackRate,
  playerSeekPosition,
  handleVideoLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  showLoadingOverlay,
  terminalPlaybackError,
  loadingLabel,
  handlePlayPause,
  effectiveIsPlaying,
  effectiveDuration,
  isSeeking,
  seekPosition,
  effectiveCurrentTime,
  handleDesktopSeekStart,
  handleDesktopSeekEnd,
  handleDesktopSeekChange,
  handleCastDisconnect,
  videoStats,
  sizeLabel,
  channelInitial,
  channelName,
  toggleReaction,
  userReaction,
  reactionCounts,
  isDownloaded,
  handleDownload,
  isDownloading,
  displayComments,
  refreshComments,
  refreshingComments,
  commentText,
  setCommentText,
  postComment,
  postingComment,
  commentsLoading,
  organizedComments,
  minimizePlayer,
  closeVideo,
}: DesktopOverlayViewProps) {
  const uploadedAt = typeof currentVideo.uploadedAt === 'number' ? currentVideo.uploadedAt : Date.now()

  return (
    <div style={{ ...desktopStyles.overlay, left: sidebarWidth, transition: 'left 0.2s ease' }}>
      <div style={desktopStyles.container}>
        <div style={desktopStyles.mainColumn}>
          <DesktopVideoStage
            desktopVideoWidth={desktopVideoWidth}
            desktopVideoHeight={desktopVideoHeight}
            isCasting={isCasting}
            castDeviceName={castDeviceName}
            currentVideo={currentVideo}
            videoUrl={videoUrl}
            playerRef={playerRef}
            playbackSession={playbackSession}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            playerSeekPosition={playerSeekPosition}
            handleVideoLoad={handleVideoLoad}
            onProgress={onProgress}
            onPlaying={onPlaying}
            onPaused={onPaused}
            onBuffering={onBuffering}
            onEnded={onEnded}
            onError={onError}
            onVideoStateChange={onVideoStateChange}
            showLoadingOverlay={showLoadingOverlay}
            terminalPlaybackError={terminalPlaybackError}
            loadingLabel={loadingLabel}
          />

          <DesktopPlaybackBar
            handlePlayPause={handlePlayPause}
            effectiveIsPlaying={effectiveIsPlaying}
            effectiveDuration={effectiveDuration}
            isSeeking={isSeeking}
            seekPosition={seekPosition}
            effectiveCurrentTime={effectiveCurrentTime}
            handleDesktopSeekStart={handleDesktopSeekStart}
            handleDesktopSeekEnd={handleDesktopSeekEnd}
            handleDesktopSeekChange={handleDesktopSeekChange}
          />

          <div style={desktopStyles.videoInfo}>
            <h1 style={desktopStyles.title}>{currentVideo.title}</h1>
            {isCasting ? (
              <div style={desktopStyles.castBanner}>
                <Feather name="cast" color={colors.primary} size={14} />
                <span style={desktopStyles.castBannerText}>Casting to {castDeviceName}</span>
                <button
                  type="button"
                  onClick={handleCastDisconnect}
                  style={desktopStyles.castDisconnectButton}
                  aria-label="Disconnect casting"
                >
                  Disconnect
                </button>
              </div>
            ) : null}

            <DesktopP2PStats videoStats={videoStats} />

            <div style={desktopStyles.meta}>
              <span>{formatTimeAgo(uploadedAt)}</span>
              {sizeLabel ? <span style={desktopStyles.dot}>•</span> : null}
              {sizeLabel ? <span>{sizeLabel}</span> : null}
            </div>

            <div style={desktopStyles.channelRow}>
              <div style={desktopStyles.avatar}>
                <span style={desktopStyles.avatarText}>{channelInitial}</span>
              </div>
              <div style={desktopStyles.channelInfo}>
                <span style={desktopStyles.channelName}>{channelName}</span>
                <span style={desktopStyles.channelKey}>{currentVideo.channelKey?.slice(0, 16)}...</span>
              </div>
            </div>

            <DesktopReactionActions
              toggleReaction={toggleReaction}
              userReaction={userReaction}
              reactionCounts={reactionCounts}
              isDownloaded={isDownloaded}
              handleDownload={handleDownload}
              isDownloading={isDownloading}
            />

            {currentVideo.description ? (
              <div style={desktopStyles.description}>
                <p style={desktopStyles.descriptionText}>{currentVideo.description}</p>
              </div>
            ) : null}

            <DesktopCommentsPanel
              displayComments={displayComments}
              refreshComments={refreshComments}
              refreshingComments={refreshingComments}
              commentText={commentText}
              setCommentText={setCommentText}
              postComment={postComment}
              postingComment={postingComment}
              commentsLoading={commentsLoading}
              organizedComments={organizedComments}
            />
          </div>
        </div>

        <button type="button" onClick={minimizePlayer} style={desktopStyles.minimizeButton} aria-label="Minimize">
          <Feather name="minus" color={colors.text} size={24} />
        </button>

        <button type="button" onClick={closeVideo} style={desktopStyles.closeButton} aria-label="Close">
          <Feather name="x" color={colors.text} size={24} />
        </button>
      </div>
    </div>
  )
}
function LegacyMiniControls({
  isPlaying,
  closeFromMini,
  maximizeFromMini,
  handlePlayPause,
}: {
  isPlaying: boolean
  closeFromMini: () => void
  maximizeFromMini: () => void
  handlePlayPause: () => void
}) {
  return (
    <>
      <View style={styles.miniPipTopRow} pointerEvents="box-none">
        <Pressable
          style={styles.miniPipSmallButton}
          onPress={closeFromMini}
          testID="mini-player-close"
        >
          <Feather name="x" size={18} color="#fff" />
        </Pressable>
        <Pressable
          style={styles.miniPipSmallButton}
          onPress={() => setTimeout(maximizeFromMini, 0)}
          testID="mini-player-maximize"
        >
          <Feather name="chevron-up" size={18} color="#fff" />
        </Pressable>
      </View>
      <Pressable
        style={styles.miniPipPlayPauseButton}
        onPress={handlePlayPause}
        testID="mini-player-play-pause"
      >
        <Feather name={isPlaying ? 'pause' : 'play'} size={22} color="#fff" />
      </Pressable>
    </>
  )
}

type MainInlineVideoPlayerProps = {
  isCasting: boolean
  castDeviceName: string
  currentVideo: VideoData
  videoUrl: string | null
  playerRef: { current: PlayerPort | null }
  playbackSession: number
  isPlaying: boolean
  playbackRate: number
  playerSeekPosition: number | undefined
  isInPipMode: boolean
  pipWindowSize: { width: number; height: number } | null
  iosPipEnabled: boolean
  handleVideoLoad: (info: { duration?: number; videoSize?: { width: number; height: number } }) => void
  handlePipStatusChanged: (event: { isInPictureInPicture: boolean; width: number; height: number }) => void
  onProgress: PlayerProgressHandler
  onPlaying: () => void
  onPaused: () => void
  onBuffering: PlayerBufferingHandler
  onEnded: () => void
  onError: (err: unknown) => void
  onVideoStateChange: PlayerVideoStateHandler
}

function MainInlineVideoPlayer({
  isCasting,
  castDeviceName,
  currentVideo,
  videoUrl,
  playerRef,
  playbackSession,
  isPlaying,
  playbackRate,
  playerSeekPosition,
  isInPipMode,
  pipWindowSize,
  iosPipEnabled,
  handleVideoLoad,
  handlePipStatusChanged,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
}: MainInlineVideoPlayerProps) {
  if (isCasting) {
    return (
      <View style={styles.castPlaceholder}>
        <Feather name="cast" size={40} color={colors.primary} />
        <Text style={styles.castPlaceholderTitle}>Casting to {castDeviceName}</Text>
        <Text style={styles.castPlaceholderSubtitle} numberOfLines={1}>
          {currentVideo.title}
        </Text>
      </View>
    )
  }

  return (
    <>
      {videoUrl && (
        <PearInlineVideoView
          style={StyleSheet.absoluteFill}
          playerRef={playerRef}
          videoUrl={videoUrl}
          playbackSession={playbackSession}
          currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          seekPosition={playerSeekPosition}
          isInPipMode={isInPipMode}
          pipWindowSize={pipWindowSize}
          pipEnabled={iosPipEnabled}
          videoTitle={currentVideo?.title}
          channelName={currentVideo?.channel?.name}
          thumbnailUrl={currentVideo?.thumbnailUrl}
          onLoad={handleVideoLoad}
          onPictureInPictureChanged={handlePipStatusChanged}
          onProgress={onProgress}
          onPlaying={onPlaying}
          onPaused={onPaused}
          onBuffering={onBuffering}
          onEnded={onEnded}
          onError={onError}
          onVideoStateChange={onVideoStateChange}
        />
      )}
      {!videoUrl && (
        <View style={styles.videoPlaceholder}>
          <Text style={styles.placeholderText}>
            {currentVideo.title.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
    </>
  )
}

type VideoControlsOverlayProps = {
  showLoadingOverlay: boolean
  isInPipMode: boolean
  terminalPlaybackError: { message: string } | null
  loadingLabel: string
  playerMode: string
  isLandscapeFullscreen: boolean
  showControls: boolean
  controlsOverlayStyle: AnimatedViewStyle
  handleDoubleTapSeek: (direction: 'left' | 'right') => void
  handlePlayPause: () => void
  effectiveIsPlaying: boolean
  seekFeedback: 'left' | 'right' | null
  fullscreenButtonsOpacityStyle: AnimatedViewStyle
  minimizeButtonStyle: AnimatedViewStyle
  minimizePlayer: () => void
  speedButtonStyle: AnimatedViewStyle
  cyclePlaybackSpeed: () => void
  playbackRate: number
  progressBarStyle: AnimatedViewStyle
  effectiveDuration: number
  effectiveCurrentTime: number
  effectiveProgress: number
  videoStats: VideoStats | null | undefined
  scrubPendingTime: number | null
  panGesture: NonNullable<React.ComponentProps<typeof Scrubber>['externalGesture']>
  handleScrubStart: () => void
  handleScrubCommit: (time: number) => void
  timeDisplayStyle: AnimatedViewStyle
  isSeeking: boolean
  seekPosition: number
  handleCastPress: () => void
  cast: { isConnected: boolean }
  toggleLandscapeFullscreen: () => void
}

function ControlsLoadingGate({
  showLoadingOverlay,
  isInPipMode,
  terminalPlaybackError,
  loadingLabel,
}: Pick<VideoControlsOverlayProps, 'showLoadingOverlay' | 'isInPipMode' | 'terminalPlaybackError' | 'loadingLabel'>) {
  if (!showLoadingOverlay || isInPipMode) return null
  return (
    <View style={styles.loadingOverlay}>
      {!terminalPlaybackError && <ActivityIndicator color="white" size="large" />}
      <Text style={styles.loadingText}>{loadingLabel}</Text>
    </View>
  )
}

function CenterPlaybackControls({
  playerMode,
  isLandscapeFullscreen,
  showControls,
  isInPipMode,
  controlsOverlayStyle,
  handleDoubleTapSeek,
  handlePlayPause,
  effectiveIsPlaying,
}: Pick<
  VideoControlsOverlayProps,
  | 'playerMode'
  | 'isLandscapeFullscreen'
  | 'showControls'
  | 'isInPipMode'
  | 'controlsOverlayStyle'
  | 'handleDoubleTapSeek'
  | 'handlePlayPause'
  | 'effectiveIsPlaying'
>) {
  if (!(playerMode === 'fullscreen' || isLandscapeFullscreen) || !showControls || isInPipMode) return null
  return (
    <Animated.View pointerEvents="box-none" style={[styles.controlsOverlayBase, controlsOverlayStyle]}>
      <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('left')}>
        <Feather name="rotate-ccw" color="#fff" size={22} />
      </Pressable>
      <Pressable style={styles.controlButtonLarge} onPress={handlePlayPause}>
        {effectiveIsPlaying ? (
          <Ionicons name="pause" color="#fff" size={32} />
        ) : (
          <Ionicons name="play" color="#fff" size={32} />
        )}
      </Pressable>
      <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('right')}>
        <Feather name="rotate-cw" color="#fff" size={22} />
      </Pressable>
    </Animated.View>
  )
}

function SeekFeedbackBadge({ seekFeedback }: Pick<VideoControlsOverlayProps, 'seekFeedback'>) {
  if (!seekFeedback) return null
  return (
    <View style={[
      styles.seekFeedback,
      seekFeedback === 'left' ? styles.seekFeedbackLeft : styles.seekFeedbackRight,
    ]}>
      {seekFeedback === 'left' ? (
        <Feather name="rotate-ccw" color="#fff" size={32} />
      ) : (
        <Feather name="rotate-cw" color="#fff" size={32} />
      )}
      <Text style={styles.seekFeedbackText}>{`${SEEK_STEP_SECONDS}s`}</Text>
    </View>
  )
}

function FullscreenChromeButtons({
  playerMode,
  showControls,
  isLandscapeFullscreen,
  isInPipMode,
  fullscreenButtonsOpacityStyle,
  minimizeButtonStyle,
  minimizePlayer,
  speedButtonStyle,
  cyclePlaybackSpeed,
  playbackRate,
}: Pick<
  VideoControlsOverlayProps,
  | 'playerMode'
  | 'showControls'
  | 'isLandscapeFullscreen'
  | 'isInPipMode'
  | 'fullscreenButtonsOpacityStyle'
  | 'minimizeButtonStyle'
  | 'minimizePlayer'
  | 'speedButtonStyle'
  | 'cyclePlaybackSpeed'
  | 'playbackRate'
>) {
  if (playerMode !== 'fullscreen' || !showControls || isLandscapeFullscreen || isInPipMode) return null
  return (
    <>
      <Animated.View style={[styles.minimizeButton, fullscreenButtonsOpacityStyle, minimizeButtonStyle]}>
        <Pressable testID="player-minimize-button" onPress={minimizePlayer} style={styles.minimizeButtonInner}>
          <Feather name="chevron-down" color="#fff" size={28} />
        </Pressable>
      </Animated.View>
      <Animated.View style={[styles.speedButton, fullscreenButtonsOpacityStyle, speedButtonStyle]}>
        <Pressable onPress={cyclePlaybackSpeed} style={styles.speedButtonInner}>
          <Text style={styles.speedButtonText}>{playbackRate}x</Text>
        </Pressable>
      </Animated.View>
    </>
  )
}

function ProgressControls({
  isInPipMode,
  playerMode,
  showControls,
  progressBarStyle,
  effectiveDuration,
  effectiveCurrentTime,
  effectiveProgress,
  videoStats,
  scrubPendingTime,
  panGesture,
  handleScrubStart,
  handleScrubCommit,
}: Pick<
  VideoControlsOverlayProps,
  | 'isInPipMode'
  | 'playerMode'
  | 'showControls'
  | 'progressBarStyle'
  | 'effectiveDuration'
  | 'effectiveCurrentTime'
  | 'effectiveProgress'
  | 'videoStats'
  | 'scrubPendingTime'
  | 'panGesture'
  | 'handleScrubStart'
  | 'handleScrubCommit'
>) {
  if (isInPipMode) return null
  if (Platform.OS === 'web') {
    return (
      <Animated.View style={progressBarStyle} pointerEvents="none">
        <View style={styles.thinProgressBg}>
          <View style={[styles.thinProgressFill, { width: `${effectiveProgress * 100}%` }]} />
        </View>
      </Animated.View>
    )
  }
  if (playerMode === 'mini' || !showControls) return null
  return (
    <Scrubber
      containerStyle={progressBarStyle}
      duration={effectiveDuration}
      currentTime={effectiveCurrentTime}
      progress={effectiveProgress}
      bufferProgress={videoStats?.progress != null ? Number(videoStats.progress) / 100 : 0}
      pendingSeekTime={scrubPendingTime}
      disabled={effectiveDuration <= 0}
      externalGesture={panGesture}
      onScrubStart={handleScrubStart}
      onSeekCommit={handleScrubCommit}
    />
  )
}

function TimeAndCastRow({
  playerMode,
  isLandscapeFullscreen,
  showControls,
  isInPipMode,
  timeDisplayStyle,
  isSeeking,
  seekPosition,
  effectiveCurrentTime,
  effectiveDuration,
  handleCastPress,
  cast,
  toggleLandscapeFullscreen,
}: Pick<
  VideoControlsOverlayProps,
  | 'playerMode'
  | 'isLandscapeFullscreen'
  | 'showControls'
  | 'isInPipMode'
  | 'timeDisplayStyle'
  | 'isSeeking'
  | 'seekPosition'
  | 'effectiveCurrentTime'
  | 'effectiveDuration'
  | 'handleCastPress'
  | 'cast'
  | 'toggleLandscapeFullscreen'
>) {
  if (!(playerMode === 'fullscreen' || isLandscapeFullscreen) || !showControls || isInPipMode) return null
  return (
    <Animated.View style={timeDisplayStyle}>
      <View style={styles.timeDisplayRow}>
        <Text style={styles.timeText}>
          <Text style={styles.timeTextCurrent}>
            {formatDuration(isSeeking ? seekPosition : effectiveCurrentTime)}
          </Text>
          <Text style={styles.timeTextMuted}>
            {' / '}
            {formatDuration(effectiveDuration)}
          </Text>
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable onPress={handleCastPress} style={styles.timeDisplayAction}>
            <Feather name="cast" color={cast.isConnected ? colors.primary : '#efeff1'} size={18} />
          </Pressable>
          <Pressable onPress={toggleLandscapeFullscreen} style={styles.timeDisplayAction}>
            <Feather
              name={isLandscapeFullscreen ? 'minimize' : 'maximize'}
              color="#efeff1"
              size={20}
            />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  )
}

function VideoControlsOverlay(props: VideoControlsOverlayProps) {
  return (
    <>
      <ControlsLoadingGate
        showLoadingOverlay={props.showLoadingOverlay}
        isInPipMode={props.isInPipMode}
        terminalPlaybackError={props.terminalPlaybackError}
        loadingLabel={props.loadingLabel}
      />
      <CenterPlaybackControls
        playerMode={props.playerMode}
        isLandscapeFullscreen={props.isLandscapeFullscreen}
        showControls={props.showControls}
        isInPipMode={props.isInPipMode}
        controlsOverlayStyle={props.controlsOverlayStyle}
        handleDoubleTapSeek={props.handleDoubleTapSeek}
        handlePlayPause={props.handlePlayPause}
        effectiveIsPlaying={props.effectiveIsPlaying}
      />
      <SeekFeedbackBadge seekFeedback={props.seekFeedback} />
      <FullscreenChromeButtons
        playerMode={props.playerMode}
        showControls={props.showControls}
        isLandscapeFullscreen={props.isLandscapeFullscreen}
        isInPipMode={props.isInPipMode}
        fullscreenButtonsOpacityStyle={props.fullscreenButtonsOpacityStyle}
        minimizeButtonStyle={props.minimizeButtonStyle}
        minimizePlayer={props.minimizePlayer}
        speedButtonStyle={props.speedButtonStyle}
        cyclePlaybackSpeed={props.cyclePlaybackSpeed}
        playbackRate={props.playbackRate}
      />
      <ProgressControls
        isInPipMode={props.isInPipMode}
        playerMode={props.playerMode}
        showControls={props.showControls}
        progressBarStyle={props.progressBarStyle}
        effectiveDuration={props.effectiveDuration}
        effectiveCurrentTime={props.effectiveCurrentTime}
        effectiveProgress={props.effectiveProgress}
        videoStats={props.videoStats}
        scrubPendingTime={props.scrubPendingTime}
        panGesture={props.panGesture}
        handleScrubStart={props.handleScrubStart}
        handleScrubCommit={props.handleScrubCommit}
      />
      <TimeAndCastRow
        playerMode={props.playerMode}
        isLandscapeFullscreen={props.isLandscapeFullscreen}
        showControls={props.showControls}
        isInPipMode={props.isInPipMode}
        timeDisplayStyle={props.timeDisplayStyle}
        isSeeking={props.isSeeking}
        seekPosition={props.seekPosition}
        effectiveCurrentTime={props.effectiveCurrentTime}
        effectiveDuration={props.effectiveDuration}
        handleCastPress={props.handleCastPress}
        cast={props.cast}
        toggleLandscapeFullscreen={props.toggleLandscapeFullscreen}
      />
    </>
  )
}

type OverlayCommentsSectionProps = {
  displayComments: Array<unknown>
  commentsLoading: boolean
  refreshComments: () => void
  refreshingComments: boolean
  replyToComment: Record<string, unknown> | null
  setReplyToComment: (c: Record<string, unknown> | null) => void
  commentText: string
  setCommentText: (text: string) => void
  postComment: () => void
  postingComment: boolean
  organizedComments: Array<Record<string, unknown>>
  isOwnComment: (c: unknown) => boolean
  deleteComment: (id: string) => void
  deletingCommentId: string | null
  canModerate: boolean
  hideComment: (id: string) => void
  hasMoreComments: boolean
  loadMoreComments: () => void
  loadingMoreComments: boolean
}

type OverlayCommentModerationProps = {
  isOwnComment: (c: unknown) => boolean
  deleteComment: (id: string) => void
  deletingCommentId: string | null
  canModerate: boolean
  hideComment: (id: string) => void
}

function OverlayReplyRow({
  reply,
  isOwnComment,
  deleteComment,
  deletingCommentId,
  canModerate,
  hideComment,
}: OverlayCommentModerationProps & { reply: Record<string, unknown> }) {
  const replyId = String(reply.commentId || '')
  const replyAuthor = String(reply.authorKeyHex || '').slice(0, 12)
  const replyTimeAgo = formatTimeAgo(typeof reply.timestamp === 'number' ? reply.timestamp : Date.now())
  const replyPending = typeof reply.pendingState === 'string' ? reply.pendingState : null
  const isReplyOwner = isOwnComment(reply)

  return (
    <View key={replyId} style={styles.replyItem}>
      <View style={styles.commentHeader}>
        <Text style={styles.commentAuthor}>
          {replyAuthor}… · {replyTimeAgo}
        </Text>
        {reply.isAdmin ? <Text style={styles.adminBadge}>Admin</Text> : null}
        {replyPending ? (
          <Text style={styles.pendingBadge}>
            {replyPending === 'failed' ? 'Failed' : 'Pending'}
          </Text>
        ) : null}
        {(isReplyOwner || replyPending) ? (
          <Pressable
            onPress={() => deleteComment(replyId)}
            disabled={deletingCommentId === replyId}
            style={styles.commentActionButton}
            accessibilityRole="button"
            accessibilityLabel="Delete comment"
            accessibilityState={{ disabled: deletingCommentId === replyId, busy: deletingCommentId === replyId }}
          >
            {deletingCommentId === replyId ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Feather name="trash-2" color="#f87171" size={14} />
            )}
          </Pressable>
        ) : null}
        {canModerate && !isReplyOwner && !replyPending ? (
          <Pressable
            onPress={() => hideComment(replyId)}
            disabled={deletingCommentId === replyId}
            style={styles.commentActionButton}
            accessibilityRole="button"
            accessibilityLabel="Hide reply"
          >
            <Feather name="eye-off" color={colors.textMuted} size={14} />
          </Pressable>
        ) : null}
      </View>
      <Text style={replyPending ? styles.commentTextPending : styles.commentText}>{String(reply.text || '')}</Text>
    </View>
  )
}

function OverlayCommentThread({
  comment,
  setReplyToComment,
  isOwnComment,
  deleteComment,
  deletingCommentId,
  canModerate,
  hideComment,
}: OverlayCommentModerationProps & {
  comment: Record<string, unknown>
  setReplyToComment: (c: Record<string, unknown> | null) => void
}) {
  const commentId = String(comment.commentId || '')
  const author = String(comment.authorKeyHex || '').slice(0, 12)
  const timeAgo = formatTimeAgo(typeof comment.timestamp === 'number' ? comment.timestamp : Date.now())
  const pending = typeof comment.pendingState === 'string' ? comment.pendingState : null
  const isOwner = isOwnComment(comment)
  const replies = Array.isArray(comment.replies) ? (comment.replies as Array<Record<string, unknown>>) : []

  return (
    <View key={commentId}>
      <View style={styles.commentItem}>
        <View style={styles.commentHeader}>
          <Text style={styles.commentAuthor}>
            {author}… · {timeAgo}
          </Text>
          {comment.isAdmin ? <Text style={styles.adminBadge}>Admin</Text> : null}
          {pending ? (
            <Text style={styles.pendingBadge}>
              {pending === 'failed' ? 'Failed' : 'Pending'}
            </Text>
          ) : null}
          <View style={styles.commentActions}>
            <Pressable
              onPress={() => setReplyToComment(comment)}
              style={styles.commentActionButton}
              accessibilityRole="button"
              accessibilityLabel="Reply to comment"
            >
              <Feather name="corner-up-left" color={colors.textMuted} size={14} />
            </Pressable>
            {(isOwner || pending) ? (
              <Pressable
                onPress={() => deleteComment(commentId)}
                disabled={deletingCommentId === commentId}
                style={styles.commentActionButton}
                accessibilityRole="button"
                accessibilityLabel="Delete comment"
                accessibilityState={{ disabled: deletingCommentId === commentId, busy: deletingCommentId === commentId }}
              >
                {deletingCommentId === commentId ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Feather name="trash-2" color="#f87171" size={14} />
                )}
              </Pressable>
            ) : null}
            {canModerate && !isOwner && !pending ? (
              <Pressable
                onPress={() => hideComment(commentId)}
                disabled={deletingCommentId === commentId}
                style={styles.commentActionButton}
                accessibilityRole="button"
                accessibilityLabel="Hide comment"
              >
                <Feather name="eye-off" color={colors.textMuted} size={14} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <Text style={pending ? styles.commentTextPending : styles.commentText}>{String(comment.text || '')}</Text>
      </View>

      {replies.length > 0 ? (
        <View style={styles.repliesContainer}>
          {replies.map((reply) => (
            <OverlayReplyRow
              key={String(reply.commentId || '')}
              reply={reply}
              isOwnComment={isOwnComment}
              deleteComment={deleteComment}
              deletingCommentId={deletingCommentId}
              canModerate={canModerate}
              hideComment={hideComment}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function OverlayCommentsList({
  displayComments,
  commentsLoading,
  organizedComments,
  setReplyToComment,
  isOwnComment,
  deleteComment,
  deletingCommentId,
  canModerate,
  hideComment,
  hasMoreComments,
  loadMoreComments,
  loadingMoreComments,
}: Pick<
  OverlayCommentsSectionProps,
  | 'displayComments'
  | 'commentsLoading'
  | 'organizedComments'
  | 'setReplyToComment'
  | 'isOwnComment'
  | 'deleteComment'
  | 'deletingCommentId'
  | 'canModerate'
  | 'hideComment'
  | 'hasMoreComments'
  | 'loadMoreComments'
  | 'loadingMoreComments'
>) {
  if (commentsLoading && displayComments.length === 0) {
    return (
      <View style={{ paddingVertical: 12 }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    )
  }
  if (displayComments.length === 0) {
    return <Text style={styles.commentsEmpty}>No comments yet. Be the first to comment!</Text>
  }
  return (
    <View style={{ gap: 12, paddingBottom: 24 }}>
      {organizedComments.map((comment) => (
        <OverlayCommentThread
          key={String(comment.commentId || '')}
          comment={comment}
          setReplyToComment={setReplyToComment}
          isOwnComment={isOwnComment}
          deleteComment={deleteComment}
          deletingCommentId={deletingCommentId}
          canModerate={canModerate}
          hideComment={hideComment}
        />
      ))}
      {hasMoreComments ? (
        <Pressable
          onPress={loadMoreComments}
          disabled={loadingMoreComments}
          style={styles.loadMoreButton}
          accessibilityRole="button"
          accessibilityLabel="Load more comments"
          accessibilityState={{ disabled: loadingMoreComments, busy: loadingMoreComments }}
        >
          {loadingMoreComments ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.loadMoreText}>Load more comments</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  )
}

function OverlayCommentsSection({
  displayComments,
  commentsLoading,
  refreshComments,
  refreshingComments,
  replyToComment,
  setReplyToComment,
  commentText,
  setCommentText,
  postComment,
  postingComment,
  organizedComments,
  isOwnComment,
  deleteComment,
  deletingCommentId,
  canModerate,
  hideComment,
  hasMoreComments,
  loadMoreComments,
  loadingMoreComments,
}: OverlayCommentsSectionProps) {
  const replyAuthor = replyToComment && typeof replyToComment.authorKeyHex === 'string'
    ? replyToComment.authorKeyHex.slice(0, 8)
    : ''

  return (
    <View style={styles.commentsSection}>
      <View style={styles.commentsHeader}>
        <Text style={styles.commentsTitle}>
          {displayComments.length > 0 ? `${displayComments.length} Comment${displayComments.length !== 1 ? 's' : ''}` : 'Comments'}
        </Text>
        <Pressable
          onPress={refreshComments}
          disabled={refreshingComments}
          style={[styles.refreshButton, refreshingComments ? { opacity: 0.5 } : null]}
          accessibilityRole="button"
          accessibilityLabel="Refresh comments"
          accessibilityState={{ disabled: refreshingComments, busy: refreshingComments }}
        >
          {refreshingComments ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="rotate-ccw" color={colors.primary} size={16} />
          )}
          <Text style={styles.refreshButtonText}>Refresh</Text>
        </Pressable>
      </View>

      {replyToComment ? (
        <View style={styles.replyIndicator}>
          <Text style={styles.replyIndicatorText}>
            Replying to {replyAuthor}…
          </Text>
          <Pressable onPress={() => { setReplyToComment(null); setCommentText('') }} style={styles.cancelReplyButton}>
            <Feather name="x" color={colors.textMuted} size={16} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.commentComposer}>
        <TextInput
          value={commentText}
          onChangeText={setCommentText}
          placeholder={replyToComment ? 'Write a reply…' : 'Add a comment…'}
          placeholderTextColor={colors.textMuted}
          style={styles.commentInput}
          multiline
          accessibilityLabel={replyToComment ? 'Write a reply' : 'Add a comment'}
        />
        <Pressable
          onPress={postComment}
          disabled={postingComment || !commentText.trim()}
          style={[styles.commentButton, (postingComment || !commentText.trim()) ? { opacity: 0.5 } : null]}
          accessibilityRole="button"
          accessibilityLabel={postingComment ? 'Posting comment' : 'Post comment'}
          accessibilityState={{ disabled: postingComment || !commentText.trim(), busy: postingComment }}
        >
          <Text style={styles.commentButtonText}>{postingComment ? 'Posting…' : 'Post'}</Text>
        </Pressable>
      </View>

      <OverlayCommentsList
        displayComments={displayComments}
        commentsLoading={commentsLoading}
        organizedComments={organizedComments}
        setReplyToComment={setReplyToComment}
        isOwnComment={isOwnComment}
        deleteComment={deleteComment}
        deletingCommentId={deletingCommentId}
        canModerate={canModerate}
        hideComment={hideComment}
        hasMoreComments={hasMoreComments}
        loadMoreComments={loadMoreComments}
        loadingMoreComments={loadingMoreComments}
      />
    </View>
  )
}

type MobileDetailContentProps = {
  isLandscapeFullscreen: boolean
  isInPipMode: boolean
  fullscreenContentStyle: AnimatedViewStyle
  isPear: boolean
  videoStats: VideoStats | null | undefined
  effectiveIsPlaying: boolean
  effectiveCurrentTime: number
  terminalPlaybackError: { message: string } | null
  currentVideo: VideoData
  isCasting: boolean
  castDeviceName: string
  handleCastDisconnect: () => void
  sizeLabel: string | null
  reactionCounts: Record<string, number>
  userReaction: string | null
  toggleReaction: (type: string) => void
  cast: {
    available: boolean
    isConnected: boolean
  }
  handleCastPress: () => void
  isConnectingCast: boolean
  isDownloaded: boolean
  handleDownload: () => void
  isDownloading: boolean
  channelName: string
  channelInitial: string
  commentsProps: OverlayCommentsSectionProps
}

function MobileDetailContent({
  isLandscapeFullscreen,
  isInPipMode,
  fullscreenContentStyle,
  isPear,
  videoStats,
  effectiveIsPlaying,
  effectiveCurrentTime,
  terminalPlaybackError,
  currentVideo,
  isCasting,
  castDeviceName,
  handleCastDisconnect,
  sizeLabel,
  reactionCounts,
  userReaction,
  toggleReaction,
  cast,
  handleCastPress,
  isConnectingCast,
  isDownloaded,
  handleDownload,
  isDownloading,
  channelName,
  channelInitial,
  commentsProps,
}: MobileDetailContentProps) {
  if (isLandscapeFullscreen || isInPipMode) return null

  return (
    <Animated.View style={[styles.fullscreenContent, fullscreenContentStyle]}>
      <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {(Platform.OS !== 'web' || isPear) && (
          <P2PStatsBar
            stats={videoStats ?? null}
            playing={effectiveIsPlaying}
            started={effectiveCurrentTime > 0}
            failed={Boolean(terminalPlaybackError)}
          />
        )}

        <View style={styles.videoInfo}>
          <Text style={styles.videoTitle}>{currentVideo.title}</Text>
          {isCasting && (
            <View style={styles.castBanner}>
              <Feather name="cast" color={colors.primary} size={14} />
              <Text style={styles.castBannerText}>Casting to {castDeviceName}</Text>
              <Pressable onPress={handleCastDisconnect} style={styles.castBannerAction}>
                <Text style={styles.castBannerActionText}>Disconnect</Text>
              </Pressable>
            </View>
          )}
          <Text style={styles.videoMeta}>
            {formatTimeAgo(typeof currentVideo.uploadedAt === 'number' ? currentVideo.uploadedAt : Date.now())}
            {sizeLabel ? ` · ${sizeLabel}` : ''}
          </Text>
        </View>

        <View style={styles.actions}>
          <ReactionButton
            reactionCounts={reactionCounts}
            userReaction={userReaction}
            onToggleReaction={toggleReaction}
          />
          <ActionButton
            icon={({ color, size }: { color: string; size: number }) => <Feather name="thumbs-down" color={color} size={size} />}
            label={`Dislike${reactionCounts.dislike ? ` (${reactionCounts.dislike})` : ''}`}
            active={userReaction === 'dislike'}
            onPress={() => toggleReaction('dislike')}
          />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="share-2" color={color} size={size} />} label="Share" />
          {cast.available && (
            <ActionButton
              icon={({ color, size }: { color: string; size: number }) => <Feather name="cast" color={color} size={size} />}
              label={cast.isConnected ? 'Casting' : 'Cast'}
              active={cast.isConnected}
              onPress={handleCastPress}
              loading={isConnectingCast}
            />
          )}
          <ActionButton
            icon={({ color, size }: { color: string; size: number }) => isDownloaded ? <Feather name="check" color={color} size={size} /> : <Feather name="download" color={color} size={size} />}
            label={isDownloaded ? 'Saved' : 'Download'}
            onPress={isDownloaded ? undefined : handleDownload}
            loading={isDownloading}
          />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="more-horizontal" color={color} size={size} />} label="More" />
        </View>

        <ChannelInfo channelName={channelName} channelInitial={channelInitial} />

        <View style={styles.divider} />

        {currentVideo.description && (
          <View style={styles.description}>
            <Text style={styles.descriptionText}>{currentVideo.description}</Text>
          </View>
        )}

        <OverlayCommentsSection {...commentsProps} />
      </ScrollView>
    </Animated.View>
  )
}


function resolveSidebarWidth(isCollapsed: boolean) {
  return isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH
}

function resolveScreenLayoutMetrics(args: {
  playerMode: string
  isInPipMode: boolean
  windowWidth: number
  windowHeight: number
  screenMetrics: { width: number; height: number }
}) {
  const isAndroidFullscreen = Platform.OS === 'android' && args.playerMode === 'fullscreen'
  const useScreenFallback = isAndroidFullscreen || (
    !args.isInPipMode &&
    args.windowWidth < args.screenMetrics.width * 0.6 &&
    args.windowHeight < args.screenMetrics.height * 0.4
  )
  const screenWidth = useScreenFallback ? args.screenMetrics.width : args.windowWidth
  const screenHeight = useScreenFallback ? args.screenMetrics.height : args.windowHeight
  return { isAndroidFullscreen, useScreenFallback, screenWidth, screenHeight }
}

function resolveDesktopVideoBox(
  screenWidth: number,
  screenHeight: number,
  effectiveAR: number,
) {
  const desktopVideoWidth = Math.min(screenWidth * 0.65, 1280)
  const desktopVideoHeightRaw = Math.round(desktopVideoWidth / effectiveAR)
  if (effectiveAR < 1) {
    return {
      desktopVideoWidth,
      desktopVideoHeight: Math.min(desktopVideoHeightRaw, Math.round(screenHeight * 0.8)),
    }
  }
  return { desktopVideoWidth, desktopVideoHeight: desktopVideoHeightRaw }
}

function resolveDiscoverOverlayFlags(
  pathname: string,
  activeLeafSegment: string | undefined,
  isDesktop: boolean,
  playerMode: string,
  isLandscapeFullscreen: boolean,
  isInPipMode: boolean,
) {
  const isDiscoverPathActive =
    pathname === '/discover' ||
    pathname === '/(tabs)/discover' ||
    activeLeafSegment === 'discover'
  const hideGlobalOverlayOnDiscover = !isDesktop && isDiscoverPathActive
  const showLegacyMiniUi =
    playerMode === 'mini' &&
    !isLandscapeFullscreen &&
    !isInPipMode &&
    !hideGlobalOverlayOnDiscover
  return { isDiscoverPathActive, hideGlobalOverlayOnDiscover, showLegacyMiniUi }
}

function resolveDesktopSurface(isDesktop: boolean, playerMode: string): 'mini' | 'overlay' | null {
  if (!isDesktop || Platform.OS !== 'web') return null
  return playerMode === 'mini' ? 'mini' : 'overlay'
}

function resolveCastPlaybackProjection(args: {
  isCasting: boolean
  castPlayback: { currentTime: number; duration: number; state: string }
  currentTime: number
  duration: number
  isPlaying: boolean
}) {
  const castIsPlaying =
    args.castPlayback.state === 'playing' || args.castPlayback.state === 'buffering'
  const effectiveCurrentTime = args.isCasting ? args.castPlayback.currentTime : args.currentTime
  const effectiveDuration = args.isCasting ? args.castPlayback.duration : args.duration
  const effectiveIsPlaying = args.isCasting ? castIsPlaying : args.isPlaying
  const effectiveProgress =
    effectiveDuration > 0 ? effectiveCurrentTime / effectiveDuration : 0
  return { castIsPlaying, effectiveCurrentTime, effectiveDuration, effectiveIsPlaying, effectiveProgress }
}

function resolveLoadingPresentation(args: {
  playbackError: { terminal?: boolean; message: string } | null | undefined
  isCasting: boolean
  castBufferingDebounced: boolean
  isLoading: boolean
  castDeviceName: string
}) {
  const terminalPlaybackError = args.playbackError?.terminal ? args.playbackError : null
  if (terminalPlaybackError) {
    return {
      terminalPlaybackError,
      showLoadingOverlay: true,
      loadingLabel: terminalPlaybackError.message,
    }
  }
  if (args.isCasting) {
    return {
      terminalPlaybackError: null,
      showLoadingOverlay: args.castBufferingDebounced,
      loadingLabel: `Casting to ${args.castDeviceName}...`,
    }
  }
  return {
    terminalPlaybackError: null,
    showLoadingOverlay: args.isLoading,
    loadingLabel: 'Connecting to P2P...',
  }
}

function resolveChannelPresentation(
  channelMetaName: string | null | undefined,
  currentVideo: VideoData,
) {
  const channelName =
    channelMetaName ||
    currentVideo.channel?.name ||
    `Channel ${currentVideo.channelKey?.slice(0, 8) || 'Unknown'}`
  return {
    channelName,
    channelInitial: channelName.charAt(0).toUpperCase(),
    sizeLabel: formatSizeLabel(currentVideo.size),
  }
}

function resolveDownloadFlags(status: string | null | undefined) {
  return {
    isDownloading: status === 'downloading' || status === 'queued',
    isDownloaded: status === 'complete',
  }
}

function shouldArmAutoPip(playerMode: string, currentVideo: VideoData | null, isCasting: boolean) {
  return (
    (playerMode === 'fullscreen' || playerMode === 'mini') &&
    currentVideo !== null &&
    !isCasting
  )
}


async function resolveCastVideoUrl(
  currentVideo: VideoData,
  videoUrl: string | null,
  getVideoUrl: typeof rpc.getVideoUrl | null | undefined,
): Promise<string | null> {
  if (videoUrl) return videoUrl
  if (!getVideoUrl) return null
  const pathValue = currentVideo.path
  const videoRef =
    typeof pathValue === 'string' && pathValue.startsWith('/')
      ? pathValue
      : currentVideo.id
  const currentVideoAny = currentVideo as VideoData & {
    publicBeeKey?: string
    blobId?: string
    blobsCoreKey?: string
  }
  const result = await getVideoUrl({
    channelKey: currentVideo.channelKey,
    videoId: videoRef,
    publicBeeKey: currentVideoAny.publicBeeKey,
    blobId: currentVideoAny.blobId,
    blobsCoreKey: currentVideoAny.blobsCoreKey,
    mimeType: currentVideo.mimeType,
  })
  return result?.url || null
}

// Mirrors window.__PEARTUBE_PLAYER__ and the dev player log for the current context video.
function useContextPlayerSyncLog(
  currentVideo: VideoData | null,
  videoUrl: string | null,
  playerMode: string,
  playerLogKeyRef: { current: string | null },
) {
  useEffect(() => {
    if (!currentVideo || playerMode === 'hidden') return
    const player = Platform.OS === 'web' ? 'react-native-video-web' : 'react-native-video'
    const channelKey = currentVideo.channelKey || currentVideo.channel?.key || ''
    const logKey = `${player}:${channelKey}:${currentVideo.id || videoUrl || ''}`
    if (playerLogKeyRef.current === logKey) return
    playerLogKeyRef.current = logKey
    if (typeof window !== 'undefined') {
      const windowState = window as any
      windowState.__PEARTUBE_PLAYER__ = {
        player,
        videoId: currentVideo.id,
        channelKey,
      }
    }
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] Using player:', player, 'video:', currentVideo.id, 'channel:', channelKey)
    }
  }, [currentVideo?.id, currentVideo?.channelKey, currentVideo?.channel?.key, videoUrl, playerMode])
}

// Auto-cast any loaded video while connected.
function useAutoCastOnVideoChange(
  isCasting: boolean,
  currentVideo: VideoData | null,
  videoUrl: string | null,
  currentTime: number,
  castPlay: ReturnType<typeof useCast>['play'],
  castAutoPlayRef: { current: string | null },
  castAutoPlayInFlightRef: { current: boolean },
) {
  useEffect(() => {
    if (!isCasting) {
      castAutoPlayRef.current = null
      castAutoPlayInFlightRef.current = false
      return
    }

    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (castAutoPlayInFlightRef.current) return

    const castKey = `${currentVideo.channelKey}:${currentVideo.id}`
    if (castAutoPlayRef.current === castKey) return

    let cancelled = false
    const startCast = async () => {
      castAutoPlayInFlightRef.current = true
      try {
        const urlToCast = await resolveCastVideoUrl(currentVideo, videoUrl, rpc?.getVideoUrl)

        if (!urlToCast || cancelled) return

        castAutoPlayRef.current = castKey
        await castPlay({
          url: urlToCast,
          contentType: currentVideo.mimeType || 'video/mp4',
          title: currentVideo.title,
          time: Math.floor(currentTime || 0),
        })
      } finally {
        castAutoPlayInFlightRef.current = false
      }
    }

    startCast()
    return () => {
      cancelled = true
    }
  }, [isCasting, currentVideo?.channelKey, currentVideo?.id, videoUrl, rpc, castPlay])
}

// Groups the video-to-download-key boundary for the current download status.
function useCurrentVideoDownloadStatus(currentVideo: VideoData | null) {
  return useCurrentDownloadStatus(
    currentVideo?.id || currentVideo?.path,
    currentVideo?.channelKey || currentVideo?.channel?.key
  )
}


type MobileOverlayFrameProps = {
  containerStyle: AnimatedViewStyle
  composedGesture: React.ComponentProps<typeof GestureDetector>['gesture']
  videoWrapperRef: React.RefObject<View | null>
  videoStyle: AnimatedViewStyle
  videoWrapperHeightShared: { value: number }
  videoPlayerStyle: AnimatedViewStyle
  handleVideoTap: () => void
  inlinePlayer: React.ReactNode
  overlayContent: React.ReactNode
  isInPipMode: boolean
  playerMode: string
  showControls: boolean
  showLegacyMiniUi: boolean
  isPlaying: boolean
  closeFromMini: () => void
  maximizeFromMini: () => void
  handlePlayPause: () => void
  detailProps: MobileDetailContentProps
  showCastPicker: boolean
  handleCloseCastPicker: () => void
  cast: {
    devices: React.ComponentProps<typeof DevicePickerModal>['devices']
    connectedDevice: React.ComponentProps<typeof DevicePickerModal>['connectedDevice']
    isDiscovering: boolean
    addManualDevice: React.ComponentProps<typeof DevicePickerModal>['onAddManualDevice']
    startDiscovery: () => void
  }
  handleCastDeviceSelect: (deviceId: string) => void
  handleCastDisconnect: () => void
}

function renderNativeTapOverlays(
  isInPipMode: boolean,
  playerMode: string,
  showControls: boolean,
  handleVideoTap: () => void,
) {
  if (isInPipMode || playerMode === 'mini') return null
  if (!showControls) {
    return (
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleVideoTap}
        testID="video-tap-overlay"
      />
    )
  }
  return (
    <Pressable
      // Leave the entire bottom controls region completely clear so
      // scrubber/timestamps/buttons never compete with the tap overlay.
      style={[StyleSheet.absoluteFill, { bottom: 140 }]}
      onPress={handleVideoTap}
      testID="video-tap-overlay-upper"
    />
  )
}

function MobileOverlayFrame({
  containerStyle,
  composedGesture,
  videoWrapperRef,
  videoStyle,
  videoWrapperHeightShared,
  videoPlayerStyle,
  handleVideoTap,
  inlinePlayer,
  overlayContent,
  isInPipMode,
  playerMode,
  showControls,
  showLegacyMiniUi,
  isPlaying,
  closeFromMini,
  maximizeFromMini,
  handlePlayPause,
  detailProps,
  showCastPicker,
  handleCloseCastPicker,
  cast,
  handleCastDeviceSelect,
  handleCastDisconnect,
}: MobileOverlayFrameProps) {
  const webBody = (
    <Pressable
      style={styles.videoBackground}
      onPress={handleVideoTap}
    >
      <Animated.View style={videoPlayerStyle}>
        {inlinePlayer}
      </Animated.View>
      {overlayContent}
    </Pressable>
  )

  const nativeBody = (
    <>
      <Animated.View style={videoPlayerStyle}>
        {inlinePlayer}
      </Animated.View>
      {renderNativeTapOverlays(isInPipMode, playerMode, showControls, handleVideoTap)}
      {overlayContent}
    </>
  )

  return (
    <>
      <Animated.View style={[styles.container, containerStyle]}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View
            ref={videoWrapperRef}
            style={[styles.videoWrapper, videoStyle]}
            onLayout={(event) => {
              const { height: h } = event.nativeEvent.layout
              if (h > 0 && h !== videoWrapperHeightShared.value) {
                videoWrapperHeightShared.value = h
              }
            }}
          >
            {Platform.OS === 'web' ? webBody : nativeBody}
          </Animated.View>
        </GestureDetector>

        {showLegacyMiniUi && showControls ? (
          <LegacyMiniControls
            isPlaying={isPlaying}
            closeFromMini={closeFromMini}
            maximizeFromMini={maximizeFromMini}
            handlePlayPause={handlePlayPause}
          />
        ) : null}

        <MobileDetailContent {...detailProps} />
      </Animated.View>
      <DevicePickerModal
        visible={showCastPicker}
        onClose={handleCloseCastPicker}
        devices={cast.devices}
        connectedDevice={cast.connectedDevice}
        isDiscovering={cast.isDiscovering}
        onDeviceSelect={handleCastDeviceSelect}
        onDisconnect={handleCastDisconnect}
        onAddManualDevice={cast.addManualDevice}
        onRefresh={cast.startDiscovery}
      />
    </>
  )
}

export function VideoPlayerOverlay() {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_EDGE_INSETS
  const pathname = usePathname()
  const segments = useSegments()
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const screenMetrics = Dimensions.get('screen')
  const { isDesktop, isPear } = usePlatform()

  // Debug log on mount
  useEffect(() => {
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] Mounted. isPear:', isPear, 'isDesktop:', isDesktop, 'Platform.OS:', Platform.OS)
      if (typeof window !== 'undefined') {
        const windowState = window as unknown as Record<string, unknown>
        console.log('[VideoPlayerOverlay] window.Pear:', !!windowState.Pear)
        console.log('[VideoPlayerOverlay] PearWorkerClient:', !!windowState.PearWorkerClient)
        console.log('[VideoPlayerOverlay] userAgent:', navigator?.userAgent?.substring(0, 100))
      }
    }
  }, [isPear, isDesktop])

  const { isCollapsed } = useSidebar()
  const { identity } = useApp()
  const {
    comments,
    commentText,
    setCommentText,
    replyToComment,
    setReplyToComment,
    commentsLoading,
    postingComment,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    deletingCommentId,
    reactionCounts,
    userReaction,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    hideComment,
    toggleReaction,
    canModerate,
    displayComments,
    organizedComments,
  } = useSocial()
  const playerLogKeyRef = useRef<string | null>(null)

  // For landscape fullscreen, track screen dimensions as shared values so the
  // animated styles can size to the live screen without React re-renders.
  const { landscapeWidth, landscapeHeight } = useLandscapeScreenDimensions()

  // Note: Orientation change mid-gesture is handled implicitly:
  // - The Dimensions change listener above updates shared values
  // - The panGesture is disabled during landscape fullscreen
  // - When exiting landscape, the layout settles before showing portrait content

  // Dynamic sidebar width for desktop overlay positioning
  const sidebarWidth = resolveSidebarWidth(isCollapsed)

  const {
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playbackError,
    playerMode,
    videoStats,
    playbackSession,
    playerRef,
    currentTime,
    duration,
    playbackRate,
    seekPosition: playerSeekPosition,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
    videoAspectRatio,
    pauseVideo,
    resumeVideo,
    closeVideo,
    minimizePlayer,
    maximizePlayer,
    maximizedForPipRef,
    seekBy,
    seekTo,
    setPlaybackRate,
    onProgress,
    onLoaded,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
    onVideoStateChange,
  } = useVideoPlayerContext()

  // Android 12+ seamless PiP can shrink the Activity window before the JS PiP event arrives.
  // Freeze PiP layout branches early based on window shrink, but avoid re-activating them
  // during the PiP exit tail where window metrics can stay small for a few frames.
  const pipExitBlockEarlyDetectRef = useRef(false)
  const pipModePrevRef = useRef(false)
  const {
    wasInPipRef,
    showControls,
    setShowControls,
    controlsTimeoutRef,
    showControlsTemporarily,
  } = useControlVisibilityTimers(isInPipMode)
  const [miniPlayerCorner, setMiniPlayerCorner] = useState<MiniPlayerCorner>('bottom-right')
  const [miniPlayerSizeMode, setMiniPlayerSizeMode] = useState<'compact' | 'expanded'>('compact')
  const [isDraggingMiniPlayer, setIsDraggingMiniPlayer] = useState(false)

  // On Android in fullscreen, ALWAYS use real screen dimensions for layout.
  // Why: Android PiP (especially Android 12+ seamless mode) shrinks the Activity
  // window BEFORE onPictureInPictureModeChanged fires the JS event. This causes
  // useWindowDimensions to return intermediate/PiP-sized values while isInPipMode
  // is still false. The non-PiP fullscreen branches of animated styles would use
  // artifact. Using screen dimensions (which never change) prevents any layout
  // disruption during PiP transitions.
  // Also handles PiP EXIT where useWindowDimensions briefly returns stale PiP sizes.
  // In PiP mode, use window dimensions directly - don't override with pipWindowSize
  // The native pipWindowSize values can be wrong (full screen size instead of PiP size)
  // React Native's useWindowDimensions gives us the actual window size
  const {
    useScreenFallback,
    screenWidth,
    screenHeight,
  } = resolveScreenLayoutMetrics({
    playerMode,
    isInPipMode,
    windowWidth,
    windowHeight,
    screenMetrics,
  })
  const {
    position: desktopMiniPlayerPosition,
    isDragging: isDraggingDesktopMiniPlayer,
    handleDragStart: handleMiniPlayerDragStart,
  } = useMiniPlayerPosition({ screenWidth, screenHeight, sidebarWidth, corner: miniPlayerCorner, setCorner: setMiniPlayerCorner })
  const isWindowLandscape = screenWidth > screenHeight

  // Keep the player page frame stable and let the native video view letterbox within it.
  const videoHeight = getPlayerPageVideoHeight(screenWidth)
  const effectiveAR = videoAspectRatio || 16 / 9

  const pipLayoutLastLogAtRef = useRef(0)
  const pipLayoutLastPayloadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!__DEV__) return
    if (Platform.OS !== 'android') return

    const isPipLayoutDebugActive = playerMode === 'fullscreen' && (
      isInPipMode || (
        windowWidth < screenMetrics.width * 0.9
        && windowHeight < screenMetrics.height * 0.9
      )
    )
    if (!isPipLayoutDebugActive) return

    const payload = {
      isInPipMode,
      isPipLayoutDebugActive,
      pipWindowSize,
      pipContainerSize: isInPipMode && pipWindowSize ? pipWindowSize : undefined,
      useScreenFallback,
      screenWidth,
      screenHeight,
      videoHeight,
      windowWidth,
      windowHeight,
      playerMode,
    }

    const now = Date.now()
    const payloadKey = JSON.stringify(payload)
    const minIntervalMs = 500
    if (now - pipLayoutLastLogAtRef.current < minIntervalMs && payloadKey === pipLayoutLastPayloadRef.current) return

    pipLayoutLastLogAtRef.current = now
    pipLayoutLastPayloadRef.current = payloadKey
    console.log('[VideoPlayerOverlay] PiP layout:', payload)
  }, [
    isInPipMode,
    pipWindowSize?.width,
    pipWindowSize?.height,
    useScreenFallback,
    screenWidth,
    screenHeight,
    videoHeight,
    windowWidth,
    windowHeight,
    playerMode,
  ])

  // Desktop video dimensions (YouTube-style - video takes ~70% width, max 1280px)
  const { desktopVideoWidth, desktopVideoHeight } = resolveDesktopVideoBox(
    screenWidth,
    screenHeight,
    effectiveAR,
  )
  const { width: dynMiniWidth, height: dynMiniHeight } = computeMiniSize(screenWidth, effectiveAR, miniPlayerSizeMode)

  useContextPlayerSyncLog(currentVideo, videoUrl, playerMode, playerLogKeyRef)

  const { height: reportedTabBarHeight, paddingBottom: reportedTabBarPadding } = useTabBarMetrics()

  // State for showing seek feedback
  const [seekFeedback, setSeekFeedback] = useState<'left' | 'right' | null>(null)

  // State for drag seeking
  const videoWrapperRef = useRef<View>(null)
  const [pipSupported, setPipSupported] = useState<boolean | null>(null)

  const autoPipEnabledRef = useRef(false)
  const [iosPipEnabled, setIosPipEnabled] = useState(false)
  const isLandscapeFullscreenShared = useSharedValue(false)
  const {
    isLandscapeFullscreen,
    toggleLandscapeFullscreen,
    exitOnModeChange,
  } = useLandscapeMode({
    isLandscapeFullscreenShared,
    showControlsTemporarily,
    screenWidth,
    screenHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    reportedTabBarHeight,
    reportedTabBarPadding,
    isWindowLandscape,
  })
  const activeLeafSegment = segments[segments.length - 1]
  const {
    hideGlobalOverlayOnDiscover,
    showLegacyMiniUi,
  } = resolveDiscoverOverlayFlags(
    pathname,
    activeLeafSegment,
    isDesktop,
    playerMode,
    isLandscapeFullscreen,
    isInPipMode,
  )
  const channelMetaName = useChannelMetaName(currentVideo, rpc)

  // Casting state
  const [showCastPicker, setShowCastPicker] = useState(false)
  const [isConnectingCast, setIsConnectingCast] = useState(false)
  const cast = useCast()
  const castPlay = cast.play
  const isCasting = cast.isConnected
  const castDeviceName = cast.connectedDevice?.name || 'Casting device'
  const castPlayback = cast.playbackState
  const {
    castIsPlaying,
    effectiveCurrentTime,
    effectiveDuration,
    effectiveIsPlaying,
    effectiveProgress,
  } = resolveCastPlaybackProjection({
    isCasting,
    castPlayback,
    currentTime,
    duration,
    isPlaying,
  })

  const {
    isSeeking,
    seekPosition,
    scrubPendingTime,
    handleDesktopSeekStart,
    handleDesktopSeekChange,
    handleDesktopSeekEnd,
    handleScrubStart,
    handleScrubCommit,
  } = useScrubberSeekSync({
    effectiveCurrentTime,
    effectiveDuration,
    isCasting,
    cast,
    seekTo,
    controlsTimeoutRef,
    setShowControls,
    showControlsTemporarily,
  })

  // Debounce cast buffering — brief BUFFERING from HLS segment transitions shouldn't flash the overlay
  const castBufferingDebounced = useCastBufferingDebounced(castPlayback.state)

  // A terminal failure replaces the loading gate: the source will not decode on
  // a later attempt, so a spinner and "connecting" would both be untrue.
  const {
    terminalPlaybackError,
    showLoadingOverlay,
    loadingLabel,
  } = resolveLoadingPresentation({
    playbackError,
    isCasting,
    castBufferingDebounced,
    isLoading,
    castDeviceName,
  })
  const castAutoPlayRef = useRef<string | null>(null)
  const castAutoPlayInFlightRef = useRef(false)

  const isOwnComment = useCallback((c: any) => {
    if (!identity?.driveKey) return false
    return c?.authorKeyHex === identity.driveKey
  }, [identity?.driveKey])

  // Cast handlers
  const handleCastPress = useCallback(() => {
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const handleCastDeviceSelect = useCallback(async (deviceId: string) => {
    setShowCastPicker(false)
    setIsConnectingCast(true)
    // Set in-flight flag BEFORE connect to prevent auto-cast effect from also calling play
    // The auto-cast effect checks this flag and bails out if true
    castAutoPlayInFlightRef.current = true
    try {
      pauseVideo()
      const success = await cast.connect(deviceId)
      if (!success) {
        setShowCastPicker(true)
        showCastAlert(cast.lastError || 'Failed to connect to Chromecast device.')
        castAutoPlayInFlightRef.current = false
        return
      }

      if (!currentVideo) {
        showCastAlert('No video selected for casting yet.')
        castAutoPlayInFlightRef.current = false
        return
      }

      let urlToCast: string | null
      try {
        urlToCast = await resolveCastVideoUrl(currentVideo, videoUrl, rpc?.getVideoUrl)
      } catch (err: any) {
        setShowCastPicker(true)
        showCastAlert(err?.message || 'Failed to resolve video URL for casting.')
        castAutoPlayInFlightRef.current = false
        return
      }

      if (!urlToCast) {
        setShowCastPicker(true)
        showCastAlert('Video URL is not ready yet. Try again once playback starts.')
        castAutoPlayInFlightRef.current = false
        return
      }

      // Set ref BEFORE play to prevent auto-cast effect from also calling play
      castAutoPlayRef.current = `${currentVideo.channelKey}:${currentVideo.id}`

      // Start casting the current video
      await cast.play({
        url: urlToCast,
        contentType: currentVideo.mimeType || 'video/mp4',
        title: currentVideo.title,
        time: currentTime,
      })
    } finally {
      setIsConnectingCast(false)
      // Reset in-flight flag - auto-cast effect can now run for different videos
      castAutoPlayInFlightRef.current = false
    }
  }, [cast, videoUrl, currentVideo, currentTime, rpc, pauseVideo])

  const handleCastDisconnect = useCallback(async () => {
    await cast.disconnect()
    if (currentVideo && videoUrl) {
      setTimeout(() => {
        resumeVideo()
      }, 80)
    }
  }, [cast, currentVideo, videoUrl, resumeVideo])

  const handleCloseCastPicker = useCallback(() => {
    setShowCastPicker(false)
    cast.stopDiscovery()
  }, [cast])

  useAutoCastOnVideoChange(
    isCasting,
    currentVideo,
    videoUrl,
    currentTime,
    castPlay,
    castAutoPlayRef,
    castAutoPlayInFlightRef,
  )

  useEffect(() => {
    if (Platform.OS === 'web') return
    // PiP support is now handled natively by react-native-video
    // showNotificationControls=true means PiP is available on Android
    setPipSupported(true)
  }, [])

  // PiP source rect is computed natively from the actual SurfaceView/TextureView
  // position. No JS-side rect needed.

  // Native overlay disabled - testing simple padding approach

  useEffect(() => {
    if (wasInPipRef.current && !isInPipMode && playerMode === 'fullscreen') {
      showControlsTemporarily()
      // Force layout recalculation after PiP exit — iOS PiP can leave
      // isPipLayoutActiveShared stale, causing the video to center vertically
      // instead of pinning to the top in portrait fullscreen.
      isPipLayoutActiveShared.value = false
      animProgress.value = 1
    }
  }, [isInPipMode, playerMode, showControlsTemporarily])

  const handlePipStatusChanged = useCallback((event: { isInPictureInPicture: boolean; width: number; height: number }) => {
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] PiP status changed:', event.isInPictureInPicture, event.width, event.height)
    }
    setIsInPipMode(event.isInPictureInPicture)
    if (event.isInPictureInPicture && event.width > 0 && event.height > 0) {
      setPipWindowSize({ width: event.width, height: event.height })
    } else if (!event.isInPictureInPicture) {
      setPipWindowSize(null)

      if (Platform.OS !== 'android' && AppState.currentState === 'active') {
        maximizePlayer('overlay-pip-exit-ios')
      }
    }
  }, [setIsInPipMode, setPipWindowSize, maximizePlayer, pipSupported, currentVideo, isCasting])

  // Handle video load - set PiP aspect ratio to match actual video dimensions
  const handleVideoLoad = useCallback((info: { duration?: number; videoSize?: { width: number; height: number } }) => {
    onLoaded()
    const width = info?.videoSize?.width
    const height = info?.videoSize?.height
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] Video loaded with dimensions:', width, 'x', height)
    }
    // PiP aspect ratio is handled natively by react-native-video
  }, [onLoaded])

   // Animation progress: 0 = mini, 1 = fullscreen
    // Initialize based on playerMode to avoid layout flash on first render
    const animProgress = useSharedValue(playerMode === 'fullscreen' ? 1 : 0)
    const isGestureActive = useSharedValue(false)
   const isInPipModeShared = useSharedValue(false)
   // Early PiP layout activation — true when PiP layout (frozen dims + translateY)
   // should be applied. Fires BEFORE isInPipMode by detecting window dimension
   // shrinkage from useWindowDimensions. On Android 12+ seamless PiP, the Activity
   // window shrinks gradually during the enter animation, so this catches the
   // transition gap where isInPipMode is still false but layout must be frozen.
   const isPipLayoutActiveShared = useSharedValue(false)
   const isAutoPipEnabledShared = useSharedValue(false)
  const isFullscreenShared = useSharedValue(playerMode === 'fullscreen')
  // Controls whether overlay elements (progress bar, time display, buttons) use
  // bottom-relative positioning (true) or top-computed positioning from
  // videoWrapperHeightShared (false). On mobile the container is already pushed
  // below the notch, so bottom-relative is correct and simpler. The false
  // branch adds insetTop again which would double-offset on Android.
  // TODO: unify positioning branches and remove this flag entirely.
  const useBottomRelativeOverlayShared = useSharedValue(Platform.OS !== 'web')
    const screenWidthShared = useSharedValue(screenWidth)
    const screenHeightShared = useSharedValue(screenHeight)
    // Raw activity window size from useWindowDimensions(). This changes during
    // Android 12+ seamless PiP (the window shrinks). Kept separate from screenWidth/
    // screenHeight which may be forced to real screen dims via useScreenFallback.
    const windowWidthShared = useSharedValue(windowWidth)
    const windowHeightShared = useSharedValue(windowHeight)
   // Real device screen dimensions — independent of PiP window resize.
   // Android system PiP: Activity stays fullscreen at compositor level,
   // so layout must use real screen size, not PiP-sized window dimensions.
    const realScreenWidthShared = useSharedValue(screenMetrics.width)
    const realScreenHeightShared = useSharedValue(screenMetrics.height)
    const videoHeightShared = useSharedValue(videoHeight)
    const miniPipDynWidthShared = useSharedValue(dynMiniWidth)
    const videoWrapperHeightShared = useSharedValue(videoHeight)
   const insetLeftShared = useSharedValue(insets.left)
   const insetRightShared = useSharedValue(insets.right)
   const insetTopShared = useSharedValue(insets.top)
   const insetBottomShared = useSharedValue(insets.bottom)
    // Stable inset refs — Android PiP enter/exit can transiently report insetTop=0.
    // If we commit that 0, we lose cutout compensation in fullscreen and PiP.
    // Treat non-zero insets as authoritative; ignore 0 unless we truly have no
    // previous non-zero value.
    const stableInsetTopRef = useRef(insets.top)
    const stableInsetBottomRef = useRef(insets.bottom)
    const lastNonZeroInsetTopRef = useRef(insets.top)
    const lastNonZeroInsetBottomRef = useRef(insets.bottom)

    const isAndroidFullscreenPipTransition = resolveAndroidFullscreenPipTransition(
      playerMode,
      isInPipMode,
      windowWidth,
      windowHeight,
      screenMetrics,
    )

    resolveStableInsets(
      insets,
      Platform.OS === 'android',
      isWindowLandscape,
      lastNonZeroInsetTopRef,
      lastNonZeroInsetBottomRef,
      stableInsetTopRef,
      stableInsetBottomRef,
      isAndroidFullscreenPipTransition,
    )
   // Frozen copies of layout values — updated ONLY when NOT in PiP.
   // Android PiP constraint: TextureView LayoutParams must NOT change during PiP
   // (resizing kills the SurfaceTexture → black screen). The PiP style branches
   // must produce EXACTLY the same dimensions as fullscreen. But videoHeight,
   // insetTop etc. get PiP-sized values once isInPipMode is true (because
   // useScreenFallback disables → screenWidth = PiP width). These frozen copies
   // hold the last fullscreen values so PiP branches can reproduce them.
   const frozenVideoHeightShared = useSharedValue(videoHeight)
   const frozenInsetTopShared = useSharedValue(insets.top)
   const frozenInsetBottomShared = useSharedValue(insets.bottom)

  // Calculate positions using measured tab bar metrics (preferred) with a safe fallback.
  // Pixel/Android gesture nav can report a non-zero bottom inset; never ignore it.
  const expectedTabBarHeight = TAB_BAR_HEIGHT + Math.max(insets.bottom, reportedTabBarPadding || 0)
  const miniPlayerBottom = Math.max(reportedTabBarHeight || 0, expectedTabBarHeight)
  const initialMiniPlayerPosition = getMobileMiniPlayerSnapPosition({
    corner: miniPlayerCorner,
    screenWidth,
    screenHeight,
    topInset: stableInsetTopRef.current,
    rightInset: insets.right,
    bottomInset: insets.bottom,
    leftInset: insets.left,
    bottomOffset: miniPlayerBottom,
    aspectRatio: effectiveAR,
    sizeMode: miniPlayerSizeMode,
  })

  // Mini player position: keep the selected corner across minimize/restore cycles on native.
  const miniPipX = useSharedValue(initialMiniPlayerPosition.x)
  const miniPipY = useSharedValue(initialMiniPlayerPosition.y)
  const isMiniPlayerModeShared = useSharedValue(playerMode === 'mini')
  const isMiniPlayerDraggingShared = useSharedValue(false)
  const miniDragStartXShared = useSharedValue(initialMiniPlayerPosition.x)
  const miniDragStartYShared = useSharedValue(initialMiniPlayerPosition.y)
  // UI-thread mirror of miniPlayerCorner for snap hysteresis (JS state can't be read in worklet)
  const currentDockCornerShared = useSharedValue<MiniPlayerCorner>(miniPlayerCorner)
  // Aspect ratio + size mode on UI thread for computeMiniSize in gesture worklets
  const aspectRatioShared = useSharedValue(effectiveAR)
  const miniPlayerSizeModeShared = useSharedValue<'compact' | 'expanded'>(miniPlayerSizeMode)
  // Dynamic mini height shared value for animated style interpolations
  const miniPipDynHeightShared = useSharedValue(dynMiniHeight)

  // Track whether gesture started in fullscreen (1) or mini (0) mode
  // Using number instead of string to avoid potential worklet string comparison issues
  const gestureStartedInFullscreen = useSharedValue(0)

   // CRITICAL: Update shared values SYNCHRONOUSLY during render, NOT in useEffect
   // useEffect runs AFTER the render commit, so worklets would see stale values
   // This is especially important for PiP mode where dimensions change rapidly
   isInPipModeShared.value = isInPipMode
   // Early PiP layout detection: activate PiP layout branches as soon as window
   // dimensions shrink, even before the JS isInPipMode event arrives.
   // On Android 12+ with setAutoEnterEnabled, the Activity window animates to PiP
   // dimensions BEFORE onPictureInPictureModeChanged fires. Without early detection,
   // the non-PiP fullscreen branches would run with intermediate/PiP-sized dimensions,
   // The 0.9 threshold catches even the START of the seamless PiP animation.
   // Uses AND (both dimensions must shrink) to avoid false positives in
   // split-screen mode where only one dimension is reduced.
    const isPipLayoutActive = computePipLayoutActive({
      isAndroid: Platform.OS === 'android',
      playerMode,
      isInPipMode,
      pipModePrevRef,
      pipExitBlockEarlyDetectRef,
      windowWidth,
      windowHeight,
      screenMetrics,
    })
    isPipLayoutActiveShared.value = isPipLayoutActive
    isAutoPipEnabledShared.value = autoPipEnabledRef.current
    isFullscreenShared.value = playerMode === 'fullscreen'
    isMiniPlayerModeShared.value = playerMode === 'mini'
    screenWidthShared.value = screenWidth
    screenHeightShared.value = screenHeight
    windowWidthShared.value = windowWidth
    windowHeightShared.value = windowHeight
    realScreenWidthShared.value = screenMetrics.width
   realScreenHeightShared.value = screenMetrics.height
   videoHeightShared.value = videoHeight
   aspectRatioShared.value = effectiveAR

   // IMPORTANT: while in mini mode, miniPipDynWidth/Height and sizeMode are
   // animation/stateful values managed by gestures/effects. Don't overwrite them
   // synchronously during render or compact->expanded toggles will flash and revert.
   if (playerMode !== 'mini') {
     miniPipDynWidthShared.value = dynMiniWidth
     miniPipDynHeightShared.value = dynMiniHeight
     miniPlayerSizeModeShared.value = miniPlayerSizeMode
   }
   insetLeftShared.value = insets.left
   insetRightShared.value = insets.right
   insetTopShared.value = stableInsetTopRef.current
   insetBottomShared.value = stableInsetBottomRef.current
   currentDockCornerShared.value = miniPlayerCorner
    // Only update frozen values when NOT in PiP (or PiP-like transition) —
    // they hold pre-PiP fullscreen values. Use isPipLayoutActive (not isInPipMode)
    // so values freeze as soon as window dimensions start shrinking.
    updateFrozenLayoutValues(
      isPipLayoutActive,
      videoHeight,
      stableInsetTopRef,
      stableInsetBottomRef,
      frozenVideoHeightShared,
      frozenInsetTopShared,
      frozenInsetBottomShared,
    )

  // Note: animProgress is driven by the playerMode effect. Avoid forcing it during render.

  const miniPlayerBottomShared = useSharedValue(miniPlayerBottom)
  useEffect(() => {
    miniPlayerBottomShared.value = miniPlayerBottom
  }, [miniPlayerBottom])

  useEffect(() => {
    if (playerMode !== 'mini' || isDraggingMiniPlayer) return
    const nextPos = getMobileMiniPlayerSnapPosition({
      corner: miniPlayerCorner,
      screenWidth,
      screenHeight,
      topInset: Math.max(stableInsetTopRef.current, insets.top),
      rightInset: insets.right,
      bottomInset: insets.bottom,
      leftInset: insets.left,
      bottomOffset: miniPlayerBottom,
      aspectRatio: effectiveAR,
      sizeMode: miniPlayerSizeMode,
    })
    miniPipX.value = withSpring(nextPos.x, SPRING_CONFIG_MINI_SNAP)
    miniPipY.value = withSpring(nextPos.y, SPRING_CONFIG_MINI_SNAP)
    miniPipDynWidthShared.value = withSpring(nextPos.width, SPRING_CONFIG_MINI_SNAP)
    miniPipDynHeightShared.value = withSpring(nextPos.height, SPRING_CONFIG_MINI_SNAP)
    miniPlayerSizeModeShared.value = miniPlayerSizeMode
    currentDockCornerShared.value = miniPlayerCorner
  }, [playerMode, screenWidth, screenHeight, miniPlayerBottom, dynMiniWidth, dynMiniHeight, miniPlayerCorner, miniPlayerSizeMode, insets.top, insets.right, insets.bottom, insets.left, isDraggingMiniPlayer, effectiveAR])

  useEffect(() => {
    // Keep animProgress driven by JS mode changes.
    // Avoid forcing animProgress synchronously during render (it kills transitions
    // and can fight gesture worklets).
    if (isInPipMode) return
    if (playerMode === 'fullscreen') {
      if (maximizedForPipRef.current) {
        // Snap instantly — user is going to background, no need to animate
        animProgress.value = 1
      } else {
        animProgress.value = withTiming(1, { duration: 250 })
      }
    } else if (playerMode === 'mini') {
      animProgress.value = withTiming(0, { duration: 250 })
    } else if (playerMode === 'hidden') {
      animProgress.value = withTiming(0, { duration: 150 })
    }
  }, [playerMode, isInPipMode])

  const maximizeFromMini = useCallback(() => {
    maximizePlayer('overlay-mini-button')
  }, [maximizePlayer])

  const toggleMiniPlayerSizeMode = useCallback(() => {
    setMiniPlayerSizeMode((prev) => (prev === 'compact' ? 'expanded' : 'compact'))
  }, [])

  const closeFromMini = useCallback(() => {
    setShowControls(false)
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
      controlsTimeoutRef.current = null
    }
    cancelAnimation(animProgress)
    pauseVideo()
    closeVideo()
  }, [closeVideo, pauseVideo, animProgress])

  const handleVideoTap = useCallback(() => {
    if (isInPipMode) return
    if (playerMode === 'fullscreen' || isLandscapeFullscreen || playerMode === 'mini') {
      if (showControls) {
        setShowControls(false)
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current)
        }
      } else {
        showControlsTemporarily()
      }
    }
  }, [isInPipMode, playerMode, isLandscapeFullscreen, showControls, showControlsTemporarily])

  // Memoize gesture to prevent recreation on every render.
  // The same pan path handles fullscreen drag-to-minimize and mobile mini-player drag/snap.
  const panGesture = useMemo(() => Gesture.Pan()
    .minDistance(12)
    .maxPointers(1)
    .onStart(() => {
      'worklet'
      if (isMiniPlayerModeShared.value && Platform.OS !== 'web') {
        isGestureActive.value = true
        isMiniPlayerDraggingShared.value = true
        cancelAnimation(miniPipX)
        cancelAnimation(miniPipY)
        miniDragStartXShared.value = miniPipX.value
        miniDragStartYShared.value = miniPipY.value
        runOnJS(setIsDraggingMiniPlayer)(true)
        return
      }
      if (isLandscapeFullscreenShared.value) return
      if (isPipLayoutActiveShared.value) return

      const startedInFullscreen = isFullscreenShared.value ? 1 : 0
      if (startedInFullscreen === 0) return

      isGestureActive.value = true
      cancelAnimation(animProgress)
      animProgress.value = 1
      gestureStartedInFullscreen.value = 1
    })
    .onUpdate((event) => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, miniPlayerSizeModeShared.value)
        const bounds = computeMiniBounds(
          screenWidthShared.value,
          screenHeightShared.value,
          insetTopShared.value,
          insetRightShared.value,
          insetBottomShared.value,
          insetLeftShared.value,
          miniPlayerBottomShared.value,
          mw,
          mh,
        )
        miniPipX.value = Math.max(bounds.leftBound - MINI_DRAG_OVERSHOOT_X, Math.min(bounds.rightBound + MINI_DRAG_OVERSHOOT_X,
          miniDragStartXShared.value + event.translationX))
        miniPipY.value = Math.max(bounds.topBound - MINI_DRAG_OVERSHOOT_TOP, Math.min(bounds.bottomBound + MINI_DRAG_OVERSHOOT_BOTTOM,
          miniDragStartYShared.value + event.translationY))
        return
      }
      if (!isGestureActive.value) return
      if (isLandscapeFullscreenShared.value) return
      if (isPipLayoutActiveShared.value) return

      const totalDistance = screenHeightShared.value - miniPlayerBottomShared.value - insetTopShared.value - miniPipDynHeightShared.value
      const dragProgress = -event.translationY / totalDistance
      animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
    })
    .onEnd((event) => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        isMiniPlayerDraggingShared.value = false
        isGestureActive.value = false

        const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, miniPlayerSizeModeShared.value)
        const bounds = computeMiniBounds(
          screenWidthShared.value,
          screenHeightShared.value,
          insetTopShared.value,
          insetRightShared.value,
          insetBottomShared.value,
          insetLeftShared.value,
          miniPlayerBottomShared.value,
          mw,
          mh,
        )
        const anchors = getCornerAnchors(bounds)
        const snap = resolveSnapTarget(
          miniPipX.value, miniPipY.value,
          event.velocityX, event.velocityY,
          anchors, mw, mh,
          currentDockCornerShared.value,
          bounds,
        )

        miniPipX.value = withSpring(snap.x, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityX })
        miniPipY.value = withSpring(snap.y, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityY })
        currentDockCornerShared.value = snap.corner
        runOnJS(setMiniPlayerCorner)(snap.corner)
        runOnJS(setIsDraggingMiniPlayer)(false)
        return
      }
      const wasActive = isGestureActive.value
      isGestureActive.value = false
      if (!wasActive) return
      if (isPipLayoutActiveShared.value) return

      const velocity = event.velocityY
      const position = animProgress.value

      let shouldMinimize = false
      if (velocity > 300) {
        shouldMinimize = true
      } else if (velocity < -300) {
        shouldMinimize = false
      } else if (position < 0.75) {
        shouldMinimize = velocity > 20
      } else {
        shouldMinimize = velocity > 100
      }

      if (shouldMinimize) {
        animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
          runOnJS(minimizePlayer)()
      } else {
        animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        runOnJS(maximizePlayer)('overlay-pan-snap')
      }
    })
    .onFinalize(() => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        isMiniPlayerDraggingShared.value = false
        runOnJS(setIsDraggingMiniPlayer)(false)
      }
      isGestureActive.value = false
  }), [minimizePlayer, maximizePlayer])

  const miniSingleTapGesture = useMemo(() => Gesture.Tap()
    .maxDuration(250)
    .maxDistance(12)
    .onEnd((_evt, success) => {
      'worklet'
      if (!success) return
      if (!isMiniPlayerModeShared.value) return
      runOnJS(handleVideoTap)()
    }), [handleVideoTap])

  const miniDoubleTapGesture = useMemo(() => Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(240)
    .maxDuration(250)
    .maxDistance(16)
    .onEnd((_evt, success) => {
      'worklet'
      if (!success) return
      if (!isMiniPlayerModeShared.value) return

      const nextMode = miniPlayerSizeModeShared.value === 'compact' ? 'expanded' : 'compact'
      miniPlayerSizeModeShared.value = nextMode

      const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, nextMode)
      const bounds = computeMiniBounds(
        screenWidthShared.value,
        screenHeightShared.value,
        insetTopShared.value,
        insetRightShared.value,
        insetBottomShared.value,
        insetLeftShared.value,
        miniPlayerBottomShared.value,
        mw,
        mh,
      )
      const anchors = getCornerAnchors(bounds)
      let target = anchors[3]
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i].corner === currentDockCornerShared.value) {
          target = anchors[i]
          break
        }
      }

      miniPipX.value = withSpring(target.x, SPRING_CONFIG_MINI_SNAP)
      miniPipY.value = withSpring(target.y, SPRING_CONFIG_MINI_SNAP)
      miniPipDynWidthShared.value = withSpring(mw, SPRING_CONFIG_MINI_SNAP)
      miniPipDynHeightShared.value = withSpring(mh, SPRING_CONFIG_MINI_SNAP)

      runOnJS(toggleMiniPlayerSizeMode)()
    }), [toggleMiniPlayerSizeMode])

  const composedGesture = useMemo(
    // Priority order:
    // 1. pan if movement occurs
    // 2. double tap for compact/expanded toggle
    // 3. single tap for mini controls
    () => Gesture.Exclusive(panGesture, miniDoubleTapGesture, miniSingleTapGesture),
    [panGesture, miniDoubleTapGesture, miniSingleTapGesture]
  )

   // Animated styles for the container
   const containerStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: landscapeWidth.value,
        height: landscapeHeight.value,
        zIndex: 9999,
        backgroundColor: '#000',
        borderRadius: 0,
      }
    }

    if (isPipLayoutActiveShared.value) {
      if (Platform.OS === 'android') {
        // Android PiP: freeze layout at fullscreen dimensions.
        // Uses isPipLayoutActiveShared instead of isInPipModeShared to activate
        // BEFORE the JS PiP event — as soon as window dimensions start shrinking
        // (Android 12+ seamless PiP animation). This prevents any layout change
        // during the transition gap.
        // realScreenWidth/Height come from Dimensions.get('screen') and never
        // change, unlike screenWidthShared which gets PiP-sized values.
        //
        return {
          position: 'absolute',
          left: 0,
          top: 0,
          width: realScreenWidthShared.value,
          height: realScreenHeightShared.value,
          zIndex: 9999,
          borderRadius: 0,
          overflow: 'hidden',
          backgroundColor: '#000',
          elevation: 0,
          opacity: 1,
        }
      }
      // iOS: PiP handled at player level, use explicit dimensions
      // IMPORTANT: must use width/height (not right/bottom) so Reanimated
      // applies the same property set as the normal branch — otherwise stale
      // right/bottom values stick after PiP exit and break layout.
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: screenWidthShared.value,
        height: screenHeightShared.value + insetBottomShared.value,
        zIndex: 9999,
        borderRadius: 0,
        backgroundColor: '#000',
      }
    }

    // On Android portrait, keep the entire fullscreen player page below the cutout
    // instead of translating the render surface inside a fixed-height slot.
    const fullscreenTopInset = Platform.OS === 'android' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value
      ? insetTopShared.value
      : 0
    const fullscreenHeightShared = screenHeightShared.value + insetBottomShared.value - fullscreenTopInset

    const width = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynWidthShared.value, screenWidthShared.value],
      Extrapolation.CLAMP
    )

    const height = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynHeightShared.value, fullscreenHeightShared],
      Extrapolation.CLAMP
    )

    const left = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipX.value, 0],
      Extrapolation.CLAMP
    )

    const top = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipY.value, fullscreenTopInset],
      Extrapolation.CLAMP
    )

    const borderRadius = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_CORNER_RADIUS, 0],
      Extrapolation.CLAMP
    )

    const isMini = animProgress.value < 0.5
    const isDragging = isMiniPlayerDraggingShared.value

    // Shadow tuning: stronger when dragging, softer when docked, zero in fullscreen
    const shadowOp = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.opacity : MINI_SHADOW_DOCKED.opacity)
      : 0
    const shadowRad = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.radius : MINI_SHADOW_DOCKED.radius)
      : 0
    const shadowOY = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.offsetY : MINI_SHADOW_DOCKED.offsetY)
      : 0
    const elev = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.elevation : MINI_SHADOW_DOCKED.elevation)
      : 0

    // Subtle scale-down while dragging
    const scale = isMini && isDragging ? MINI_DRAG_SCALE : 1

    return {
      position: 'absolute',
      left,
      top,
      width,
      height,
      zIndex: 9999,
      borderRadius,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: shadowOY },
      shadowOpacity: shadowOp,
      shadowRadius: shadowRad,
      elevation: Platform.OS === 'android' ? elev : 0,
      transform: [{ scale }],
    }
  }, [])

  const videoStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        width: landscapeWidth.value,
        height: landscapeHeight.value,
        transform: [],
      }
    }

    if (isPipLayoutActiveShared.value) {
      if (Platform.OS === 'android') {
        // Freeze at EXACTLY the same dimensions as fullscreen to prevent
        // any Yoga relayout. TextureView LayoutParams change = black screen.
        // Android cutout handling already happens natively via MediaSession.
        return {
          width: realScreenWidthShared.value,
          height: frozenVideoHeightShared.value,
          flex: undefined,
          transform: [],
        }
      }
      // iOS PiP: use explicit dimensions — never flex:1 (Reanimated won't clear it on branch switch)
      return {
        width: screenWidthShared.value,
        height: videoHeightShared.value,
        flex: undefined,
        transform: [],
      }
    }

    const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
    const effectiveInsetTop = Platform.OS !== 'web' && !isLandscapeFullscreenShared.value
      ? Math.max(frozenInsetTopShared.value, insetTopShared.value)
      : 0
    const cutoutInset = Platform.OS === 'ios' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value
      ? effectiveInsetTop * cutoutFactor
      : 0

    const fullW = screenWidthShared.value
    const fullH = videoHeightShared.value + cutoutInset

    // Android mini-mode PiP reliability: keep the native player layer at a
    // fullscreen-width baseline, but make the baseline height match the ACTUAL
    // video aspect ratio instead of the generic player-page frame. Otherwise the
    // scaled mini wrapper carries fullscreen letterboxing into the mini player.
    if (Platform.OS === 'android' && isMiniPlayerModeShared.value) {
      const videoAr = aspectRatioShared.value > 0 ? aspectRatioShared.value : 16 / 9
      const baselineH = fullW / videoAr
      const scaleX = fullW > 0 ? miniPipDynWidthShared.value / fullW : 1
      const scaleY = baselineH > 0 ? miniPipDynHeightShared.value / baselineH : 1
      return {
        width: fullW,
        height: baselineH,
        flex: undefined,
        transformOrigin: 'left top',
        transform: [{ scaleX }, { scaleY }],
      }
    }

    // Non-Android-mini: interpolate directly to the same mini dimensions as the
    // outer container so the wrapper and video stay aligned.
    const width = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynWidthShared.value, fullW],
      Extrapolation.CLAMP
    )
    const height = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynHeightShared.value, fullH],
      Extrapolation.CLAMP
    )

    return {
      width,
      height,
      flex: undefined,
      transform: [],
    }
  }, [])

  // Animated styles for mini player info (fades out when expanding)
  const miniInfoStyle = useAnimatedStyle(() => {
    'worklet'
    const opacity = interpolate(
      animProgress.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    )

    return {
      opacity,
      display: animProgress.value > 0.5 ? 'none' : 'flex',
    }
  }, [])

  // Animated styles for fullscreen content (fades in when expanding)
  // Uses absolute positioning to avoid flex layout issues with animated parent containers.
  // Positioned at top: videoHeight to start exactly where the video ends.
  const fullscreenContentStyle = useAnimatedStyle(() => {
    'worklet'
    // When in fullscreen mode (animProgress = 1), always show content at full opacity
    // The interpolation is only for the mini->fullscreen animation transition
    const isFullscreen = animProgress.value >= 0.95
    const opacity = isFullscreen ? 1 : interpolate(
      animProgress.value,
      [0.5, 1],
      [0, 1],
      Extrapolation.CLAMP
    )

    const cutoutInset = Platform.OS === 'ios' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value && animProgress.value >= 0.95
      ? insetTopShared.value
      : 0
    // Calculate top position - video height for fullscreen, mini pip height for mini
    const top = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynHeightShared.value, videoHeightShared.value + cutoutInset],
      Extrapolation.CLAMP
    )

    return {
      position: 'absolute',
      top,
      left: 0,
      right: 0,
      bottom: 0,
      opacity,
      display: animProgress.value < 0.3 ? 'none' : 'flex',
    }
  }, [])

   // Opacity-only style for overlay buttons (minimize, speed, cast) - no position overrides
   const fullscreenButtonsOpacityStyle = useAnimatedStyle(() => {
     'worklet'
     if (isFullscreenShared.value) {
       return {
         opacity: 1,
         display: 'flex',
       }
     }

     const isFullscreen = animProgress.value >= 0.95
     const opacity = isFullscreen ? 1 : interpolate(
       animProgress.value,
       [0.5, 1],
       [0, 1],
       Extrapolation.CLAMP
     )

     return {
       opacity,
       display: animProgress.value < 0.3 ? 'none' : 'flex',
     }
   }, [])

   // Video player positioning - always fill container
  const videoPlayerStyle = useAnimatedStyle(() => {
    'worklet'
    // Android PiP: freeze at EXACTLY the same position as fullscreen.
    // Cutout handling is already applied natively, so the JS wrapper stays at top: 0.
    if (isPipLayoutActiveShared.value && Platform.OS === 'android') {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }
    }
    // iOS PiP: explicit width/height (not right/bottom) for Reanimated consistency
    if (isPipLayoutActiveShared.value) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        width: screenWidthShared.value,
        height: videoHeightShared.value,
      }
    }
    // Only iOS needs JS-level cutout compensation here. Android fullscreen uses
    // the native MediaSession overlay + SurfaceView inset instead.
    const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
    const effectiveInsetTop = Platform.OS !== 'web' && !isLandscapeFullscreenShared.value
      ? Math.max(frozenInsetTopShared.value, insetTopShared.value)
      : 0
    const cutoutOffset = Platform.OS === 'ios'
      && !isInPipModeShared.value
      && !isLandscapeFullscreenShared.value
        ? effectiveInsetTop * cutoutFactor
        : 0
    return {
      position: 'absolute',
      top: cutoutOffset,
      left: 0,
      right: 0,
      bottom: 0,
    }
  }, [])

  // Controls overlay positioning - always fill the container
  const controlsOverlayStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value || isLandscapeFullscreenShared.value || isInPipModeShared.value || animProgress.value < 0.95) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }
    }
    const wrapperHeight = useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      width: screenWidthShared.value,
      height: wrapperHeight,
    }
  }, [])

   // Progress bar style - positions at bottom, adjusts for landscape
  const progressBarStyle = useAnimatedStyle(() => {
    'worklet'
    // Landscape fullscreen: near bottom
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 12,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
        zIndex: 15,
        opacity: 1,
      }
    }

    // Bottom-relative overlay (e.g. fullscreen portrait with bottom-relative positioning)
    if (useBottomRelativeOverlayShared.value) {
      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )
      return {
        position: 'absolute',
        bottom: isFullscreenShared.value ? 12 : 0,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
        zIndex: 15,
        opacity: isFullscreenShared.value ? 1 : opacity,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
    const baseHeight = (useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)) + cutoutInset

    // Fullscreen portrait: near video bottom
    if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - 32 - 12,
        bottom: undefined,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
        zIndex: 15,
        opacity: 1,
      }
    }

    // Portrait non-fullscreen: flush at video bottom.
    // No opacity animation here — the Scrubber's own `visible` prop
    // (driven by showControls) is the sole visibility controller.
    return {
      position: 'absolute',
      top: baseHeight - 32,
      bottom: undefined,
      left: 0,
      right: 0,
      height: 32,
      justifyContent: 'center',
      zIndex: 15,
    }
  }, [])

   // Time display style - positions above progress bar
  const timeDisplayStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 44,
        left: 24,
        right: 24,
        zIndex: 10,
        opacity: 1,
      }
    }

    if (useBottomRelativeOverlayShared.value) {
      const opacity = isFullscreenShared.value ? 1 : 0
      return {
        position: 'absolute',
        bottom: 44,
        left: 24,
        right: 24,
        zIndex: 10,
        opacity,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
    const baseHeight = (useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)) + cutoutInset

    if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - 32 - 12 - 24,
        bottom: undefined,
        left: 24,
        right: 24,
        zIndex: 10,
        opacity: 1,
      }
    }

    return {
      position: 'absolute',
      top: baseHeight - 32 - 12 - 24,
      bottom: undefined,
      left: 16,
      right: 16,
      zIndex: 10,
      opacity: 0,
    }
  }, [])

  const actionButtonOffset = 84

  const minimizeButtonStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value) {
      return {
        top: 12,
      }
    }
    return {
      top: insetTopShared.value + 12,
    }
  }, [])

  const speedButtonStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value) {
      return {
        top: 12,
      }
    }
    return {
      top: insetTopShared.value + 12,
    }
  }, [])

  const castButtonStyle = useAnimatedStyle(() => {
    'worklet'
     if (isLandscapeFullscreenShared.value) {
       return {
         bottom: 64,
       }
     }

    if (useBottomRelativeOverlayShared.value) {
      return {
        bottom: 24,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
     const baseHeight = (useBottomRelativeOverlayShared.value
       ? videoHeightShared.value
       : (videoWrapperHeightShared.value > 0
         ? videoWrapperHeightShared.value
         : videoHeightShared.value)) + cutoutInset

     return {
       top: baseHeight - actionButtonOffset,
     }
    }, [])

  // Note: videoAreaStyle wrapper removed - fullscreenContent now uses absolute positioning
  // with top: videoHeight to position content below video, avoiding flex layout issues

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    if (isCasting) {
      if (castIsPlaying) {
        cast.pause()
      } else {
        cast.resume()
      }
      return
    }

    if (isPlaying) {
      pauseVideo()
    } else {
      resumeVideo()
    }
  }, [isCasting, castIsPlaying, cast, isPlaying, pauseVideo, resumeVideo])

  // Handle double-tap seek - ±SEEK_STEP_SECONDS forward/backward
  const handleDoubleTapSeek = useCallback((direction: 'left' | 'right') => {
    const delta = direction === 'left' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
    if (isCasting) {
      const nextTime = Math.max(0, Math.min(effectiveCurrentTime + delta, effectiveDuration || 0))
      cast.seek(nextTime)
    } else {
      seekBy(delta)
    }
    setSeekFeedback(direction)
    setTimeout(() => setSeekFeedback(null), 500)
  }, [isCasting, effectiveCurrentTime, effectiveDuration, cast, seekBy])

  // Cycle through playback speeds
  const cyclePlaybackSpeed = useCallback(() => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate)
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
    setPlaybackRate(PLAYBACK_SPEEDS[nextIndex])
  }, [playbackRate, setPlaybackRate])

  // Exit landscape fullscreen when player mode changes to mini or hidden
  useEffect(() => {
    if (Platform.OS === 'web') return
    exitOnModeChange(playerMode)
  }, [playerMode, exitOnModeChange])

  // PiP and surface inset handling is now done natively by react-native-video
  // setSurfaceViewInset and setAutoPictureInPicture are no longer needed

  // Unified PiP arming effect - now handled natively by react-native-video
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (isInPipMode) return
    const shouldEnable = shouldArmAutoPip(playerMode, currentVideo, isCasting)
    autoPipEnabledRef.current = shouldEnable
    if (Platform.OS === 'ios') {
      setIosPipEnabled(shouldEnable)
    }
  }, [playerMode, currentVideo, isCasting, pipSupported, isInPipMode, isLandscapeFullscreen])

  // Downloads context for browser-style download manager
  const { addDownload } = useDownloads()
  const currentDownloadStatus = useCurrentVideoDownloadStatus(currentVideo)
  const { isDownloading, isDownloaded } = resolveDownloadFlags(currentDownloadStatus)

  // Handle video download - adds to downloads queue
  const handleDownload = useCallback(async () => {
    if (!currentVideo || isDownloading) return

    // Ensure RPC is ready
    if (!rpc) {
      Alert.alert('Download Failed', 'Backend not ready yet. Please try again in a moment.')
      return
    }

    // Get channel key from the video
    const channelKey = currentVideo.channelKey || currentVideo.channel?.key
    if (!channelKey) {
      Alert.alert('Download Failed', 'Could not determine channel for this video')
      return
    }

    // Add to downloads queue - DownloadsContext handles the rest
    await addDownload({
      ...currentVideo,
      channelKey,
    }, rpc)
  }, [currentVideo, isDownloading, addDownload])

  // Debug: log player state
  useEffect(() => {
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] State:', {
        hasCurrentVideo: !!currentVideo,
        videoId: currentVideo?.id,
        playerMode,
        videoUrl: videoUrl?.substring(0, 50),
        isPear,
        isDesktop,
      })
    }
  }, [currentVideo, playerMode, videoUrl, isPear, isDesktop])

  useEffect(() => {
    console.log('[VideoPlayerOverlay] route/player:', JSON.stringify({
      pathname,
      activeLeafSegment,
      hideGlobalOverlayOnDiscover,
      hasCurrentVideo: Boolean(currentVideo),
      playerMode,
      hasVideoUrl: Boolean(videoUrl),
    }))
  }, [activeLeafSegment, currentVideo, hideGlobalOverlayOnDiscover, pathname, playerMode, videoUrl])

  if (!currentVideo || playerMode === 'hidden') {
    return null
  }

  if (hideGlobalOverlayOnDiscover) {
    return null
  }

  // A publication-backed title carries its byte length on the signed manifest;
  // a title that reached the player without one has no size to state at all.
  const { channelName, channelInitial, sizeLabel } = resolveChannelPresentation(
    channelMetaName,
    currentVideo,
  )

  const desktopSurface = resolveDesktopSurface(isDesktop, playerMode)

  // Desktop mini player mode
  if (desktopSurface === 'mini') {
    return (
      <DesktopMiniPlayerView
        currentVideo={currentVideo}
        videoUrl={videoUrl}
        playerRef={playerRef}
        playbackSession={playbackSession}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        playerSeekPosition={playerSeekPosition}
        handleVideoLoad={handleVideoLoad}
        onProgress={onProgress}
        onPlaying={onPlaying}
        onPaused={onPaused}
        onBuffering={onBuffering}
        onEnded={onEnded}
        onError={onError}
        onVideoStateChange={onVideoStateChange}
        isCasting={isCasting}
        effectiveIsPlaying={effectiveIsPlaying}
        handlePlayPause={handlePlayPause}
        effectiveProgress={effectiveProgress}
        maximizeFromMini={maximizeFromMini}
        channelName={channelName}
        desktopMiniPlayerPosition={desktopMiniPlayerPosition}
        isDraggingDesktopMiniPlayer={isDraggingDesktopMiniPlayer}
        handleMiniPlayerDragStart={handleMiniPlayerDragStart}
        closeVideo={closeVideo}
      />
    )
  }

  // Desktop: YouTube-style layout (fullscreen overlay)
  if (desktopSurface === 'overlay') {
    return (
      <DesktopOverlayView
        sidebarWidth={sidebarWidth}
        desktopVideoWidth={desktopVideoWidth}
        desktopVideoHeight={desktopVideoHeight}
        isCasting={isCasting}
        castDeviceName={castDeviceName}
        currentVideo={currentVideo}
        videoUrl={videoUrl}
        playerRef={playerRef}
        playbackSession={playbackSession}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        playerSeekPosition={playerSeekPosition}
        handleVideoLoad={handleVideoLoad}
        onProgress={onProgress}
        onPlaying={onPlaying}
        onPaused={onPaused}
        onBuffering={onBuffering}
        onEnded={onEnded}
        onError={onError}
        onVideoStateChange={onVideoStateChange}
        showLoadingOverlay={showLoadingOverlay}
        terminalPlaybackError={terminalPlaybackError}
        loadingLabel={loadingLabel}
        handlePlayPause={handlePlayPause}
        effectiveIsPlaying={effectiveIsPlaying}
        effectiveDuration={effectiveDuration}
        isSeeking={isSeeking}
        seekPosition={seekPosition}
        effectiveCurrentTime={effectiveCurrentTime}
        handleDesktopSeekStart={handleDesktopSeekStart}
        handleDesktopSeekEnd={handleDesktopSeekEnd}
        handleDesktopSeekChange={handleDesktopSeekChange}
        handleCastDisconnect={handleCastDisconnect}
        videoStats={videoStats}
        sizeLabel={sizeLabel}
        channelInitial={channelInitial}
        channelName={channelName}
        toggleReaction={toggleReaction}
        userReaction={userReaction}
        reactionCounts={reactionCounts}
        isDownloaded={isDownloaded}
        handleDownload={handleDownload}
        isDownloading={isDownloading}
        displayComments={displayComments}
        refreshComments={refreshComments}
        refreshingComments={refreshingComments}
        commentText={commentText}
        setCommentText={setCommentText}
        postComment={postComment}
        postingComment={postingComment}
        commentsLoading={commentsLoading}
        organizedComments={organizedComments as Array<Record<string, unknown>>}
        minimizePlayer={minimizePlayer}
        closeVideo={closeVideo}
      />
    )
  }

  const commentsProps: OverlayCommentsSectionProps = {
    displayComments,
    commentsLoading,
    refreshComments,
    refreshingComments,
    replyToComment: replyToComment as Record<string, unknown> | null,
    setReplyToComment: setReplyToComment as (c: Record<string, unknown> | null) => void,
    commentText,
    setCommentText,
    postComment,
    postingComment,
    organizedComments: organizedComments as Array<Record<string, unknown>>,
    isOwnComment,
    deleteComment,
    deletingCommentId,
    canModerate,
    hideComment,
    hasMoreComments,
    loadMoreComments,
    loadingMoreComments,
  }

  const overlayContent = (
    <VideoControlsOverlay
      showLoadingOverlay={showLoadingOverlay}
      isInPipMode={isInPipMode}
      terminalPlaybackError={terminalPlaybackError}
      loadingLabel={loadingLabel}
      playerMode={playerMode}
      isLandscapeFullscreen={isLandscapeFullscreen}
      showControls={showControls}
      controlsOverlayStyle={controlsOverlayStyle}
      handleDoubleTapSeek={handleDoubleTapSeek}
      handlePlayPause={handlePlayPause}
      effectiveIsPlaying={effectiveIsPlaying}
      seekFeedback={seekFeedback}
      fullscreenButtonsOpacityStyle={fullscreenButtonsOpacityStyle}
      minimizeButtonStyle={minimizeButtonStyle}
      minimizePlayer={minimizePlayer}
      speedButtonStyle={speedButtonStyle}
      cyclePlaybackSpeed={cyclePlaybackSpeed}
      playbackRate={playbackRate}
      progressBarStyle={progressBarStyle}
      effectiveDuration={effectiveDuration}
      effectiveCurrentTime={effectiveCurrentTime}
      effectiveProgress={effectiveProgress}
      videoStats={videoStats}
      scrubPendingTime={scrubPendingTime}
      panGesture={panGesture}
      handleScrubStart={handleScrubStart}
      handleScrubCommit={handleScrubCommit}
      timeDisplayStyle={timeDisplayStyle}
      isSeeking={isSeeking}
      seekPosition={seekPosition}
      handleCastPress={handleCastPress}
      cast={cast}
      toggleLandscapeFullscreen={toggleLandscapeFullscreen}
    />
  )

  const inlinePlayer = (
    <MainInlineVideoPlayer
      isCasting={isCasting}
      castDeviceName={castDeviceName}
      currentVideo={currentVideo}
      videoUrl={videoUrl}
      playerRef={playerRef}
      playbackSession={playbackSession}
      isPlaying={isPlaying}
      playbackRate={playbackRate}
      playerSeekPosition={playerSeekPosition}
      isInPipMode={isInPipMode}
      pipWindowSize={pipWindowSize}
      iosPipEnabled={iosPipEnabled}
      handleVideoLoad={handleVideoLoad}
      handlePipStatusChanged={handlePipStatusChanged}
      onProgress={onProgress}
      onPlaying={onPlaying}
      onPaused={onPaused}
      onBuffering={onBuffering}
      onEnded={onEnded}
      onError={onError}
      onVideoStateChange={onVideoStateChange}
    />
  )

  const detailProps: MobileDetailContentProps = {
    isLandscapeFullscreen,
    isInPipMode,
    fullscreenContentStyle,
    isPear,
    videoStats,
    effectiveIsPlaying,
    effectiveCurrentTime,
    terminalPlaybackError,
    currentVideo,
    isCasting,
    castDeviceName,
    handleCastDisconnect,
    sizeLabel,
    reactionCounts,
    userReaction,
    toggleReaction,
    cast,
    handleCastPress,
    isConnectingCast,
    isDownloaded,
    handleDownload,
    isDownloading,
    channelName,
    channelInitial,
    commentsProps,
  }

  return (
    <MobileOverlayFrame
      containerStyle={containerStyle}
      composedGesture={composedGesture}
      videoWrapperRef={videoWrapperRef}
      videoStyle={videoStyle}
      videoWrapperHeightShared={videoWrapperHeightShared}
      videoPlayerStyle={videoPlayerStyle}
      handleVideoTap={handleVideoTap}
      inlinePlayer={inlinePlayer}
      overlayContent={overlayContent}
      isInPipMode={isInPipMode}
      playerMode={playerMode}
      showControls={showControls}
      showLegacyMiniUi={showLegacyMiniUi}
      isPlaying={isPlaying}
      closeFromMini={closeFromMini}
      maximizeFromMini={maximizeFromMini}
      handlePlayPause={handlePlayPause}
      detailProps={detailProps}
      showCastPicker={showCastPicker}
      handleCloseCastPicker={handleCloseCastPicker}
      cast={cast}
      handleCastDeviceSelect={handleCastDeviceSelect}
      handleCastDisconnect={handleCastDisconnect}
    />
  )
}
