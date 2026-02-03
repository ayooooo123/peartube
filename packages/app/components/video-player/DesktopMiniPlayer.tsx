/**
 * DesktopMiniPlayer - Draggable mini player for Pear desktop
 *
 * A floating mini player that can be dragged to different corners,
 * with play/pause, maximize, and close controls.
 */

import { memo } from 'react'
import { ActivityIndicator, Text } from 'react-native'
import { Feather, Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { MpvPlayer, MpvPlayerRef } from '../MpvPlayer'
import { desktopStyles } from './desktopStyles'
import {
  DESKTOP_MINI_WIDTH,
  DESKTOP_MINI_HEIGHT,
  DESKTOP_MINI_CONTROLS_HEIGHT,
} from './constants'

interface DesktopMiniPlayerProps {
  // Position and drag
  position: { x: number; y: number }
  isDragging: boolean
  onDragStart: (e: React.MouseEvent) => void

  // Video state
  videoUrl: string | null
  currentVideo: {
    title: string
    channelKey?: string
    id?: string
  } | null
  playbackSession: number
  playerRef: React.RefObject<MpvPlayerRef>
  isPlaying: boolean
  progress: number
  isCasting: boolean

  // Channel info
  channelName: string

  // Callbacks
  onPlayPause: () => void
  onMaximize: () => void
  onClose: () => void

  // VLC callbacks
  onPlaying: () => void
  onPaused: () => void
  onEnded: () => void
  onError: (err: any) => void
  onProgress: (data: { currentTime: number; duration: number }) => void
}

export const DesktopMiniPlayer = memo(function DesktopMiniPlayer({
  position,
  isDragging,
  onDragStart,
  videoUrl,
  currentVideo,
  playbackSession,
  playerRef,
  isPlaying,
  progress,
  isCasting,
  channelName,
  onPlayPause,
  onMaximize,
  onClose,
  onPlaying,
  onPaused,
  onEnded,
  onError,
  onProgress,
}: DesktopMiniPlayerProps) {
  if (!currentVideo) return null

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: DESKTOP_MINI_WIDTH,
        zIndex: 9999,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: colors.bg,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
        border: `1px solid ${colors.border}`,
        cursor: isDragging ? 'grabbing' : 'default',
        userSelect: 'none',
        transition: isDragging ? 'none' : 'left 0.2s ease, top 0.2s ease',
      }}
    >
      {/* Drag handle - top bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 32,
          cursor: isDragging ? 'grabbing' : 'grab',
          zIndex: 10,
        }}
        onMouseDown={onDragStart}
      />

      {/* Video container */}
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
          <MpvPlayer
            key={`mpv-mini:${playbackSession}:${currentVideo.channelKey || ''}:${currentVideo.id || videoUrl}`}
            ref={playerRef}
            url={videoUrl}
            autoPlay
            onCanPlay={onPlaying}
            onPaused={onPaused}
            onPlaying={onPlaying}
            onEnded={onEnded}
            onError={(err) => onError({ nativeEvent: { error: err } })}
            onProgress={(data) => onProgress({
              currentTime: data.currentTime * 1000,
              duration: data.duration * 1000,
            })}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div style={{ ...desktopStyles.placeholder, height: DESKTOP_MINI_HEIGHT }}>
            <span style={{ fontSize: 32, color: colors.primary, fontWeight: '600' }}>
              {currentVideo.title.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {/* Hover overlay with play/pause */}
        <div
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
          onClick={onPlayPause}
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
            {isPlaying ? (
              <Ionicons name="pause" color="#fff" size={24} />
            ) : (
              <Ionicons name="play" color="#fff" size={24} />
            )}
          </div>
        </div>

        {/* Progress bar at bottom of video */}
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
              width: `${progress * 100}%`,
              backgroundColor: colors.primary,
              transition: 'width 0.1s linear',
            }}
          />
        </div>
      </div>

      {/* Controls bar */}
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
        {/* Title and channel */}
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onMaximize}>
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

        {/* Control buttons */}
        <button
          onClick={onPlayPause}
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
          {isPlaying ? (
            <Ionicons name="pause" color={colors.text} size={18} />
          ) : (
            <Ionicons name="play" color={colors.text} size={18} />
          )}
        </button>

        <button
          onClick={onMaximize}
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
          onClick={onClose}
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

      {/* CSS for hover effect on video overlay */}
      <style>{`
        .mini-player-overlay:hover {
          opacity: 1 !important;
        }
      `}</style>
    </div>
  )
})
