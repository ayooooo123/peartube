/**
 * Video Player Mobile Styles
 *
 * React Native StyleSheet for the video player overlay on iOS/Android.
 */

import { StyleSheet } from 'react-native'
import { ABSOLUTE_FILL } from '@/lib/absolute-fill'
import { colors } from '@peartube/core'
import { MINI_PIP_WIDTH, MINI_PIP_HEIGHT } from './constants'

const PLAYER_COLORS = {
  brandPurple: colors.primary,
  brandPurpleAlpha35: colors.primaryLight,
  whiteAlpha15: colors.borderSubtle,
  black: colors.contrast,
  blackShadow: colors.contrast
  } as const;

const PLAYER_Z_INDEX = {
  overlay: 9999,
  controls: 15,
  base: 10
  } as const;

export const styles = StyleSheet.create({
  container: {
    // Use black background to ensure PiP shows black (not grey) for any offset areas
    // This makes the video look properly letterboxed rather than broken
    backgroundColor: PLAYER_COLORS.black,
    overflow: 'hidden'
  },
  // Landscape fullscreen styles
  landscapeContainer: {
    ...ABSOLUTE_FILL,
    backgroundColor: PLAYER_COLORS.black,
    zIndex: PLAYER_Z_INDEX.overlay
  },
  landscapeAnimatedContainer: {
    ...ABSOLUTE_FILL,
    backgroundColor: PLAYER_COLORS.black
  },
  landscapeExitButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20
  },
  landscapeTimeDisplay: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    backgroundColor: colors.overlayButton,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    zIndex: 20
  },
  landscapeProgressContainer: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    height: 24,
    justifyContent: 'center',
    zIndex: 20
  },
  landscapeVideoWrapper: {
    ...ABSOLUTE_FILL,
    flex: 1,
    backgroundColor: PLAYER_COLORS.black
  },
  videoWrapper: {
    backgroundColor: PLAYER_COLORS.black,
    overflow: 'hidden'
  },
  videoBackground: {
    flex: 1,
    backgroundColor: PLAYER_COLORS.black
  },
  landscapeVideoBackground: {
    ...ABSOLUTE_FILL,
    backgroundColor: PLAYER_COLORS.black
  },
  videoPlaceholder: {
    flex: 1,
    backgroundColor: colors.bgHover,
    justifyContent: 'center',
    alignItems: 'center'
  },
  placeholderText: {
    color: colors.primary,
    fontSize: 32,
    fontWeight: '600'
  },
  castPlaceholder: {
    flex: 1,
    backgroundColor: colors.bgHover,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24
  },
  castPlaceholderTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600'
  },
  castPlaceholderSubtitle: {
    color: colors.textMuted,
    fontSize: 12
  },
  castBanner: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: colors.bgCard,
    alignSelf: 'flex-start'
  },
  castBannerText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600'
  },
  castBannerAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: colors.bgSecondary
  },
  castBannerActionText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '600'
  },
  loadingOverlay: {
    ...ABSOLUTE_FILL,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center'
  },
  loadingText: {
    color: colors.text,
    marginTop: 12,
    fontSize: 14
  },
  // Custom controls overlay - positioning handled by controlsOverlayStyle animated style
  controlsOverlayBase: {
    // No background — gradients handle the darkening
    backgroundColor: 'transparent',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 36
  },
  controlButton: {
    width: 56,
    height: 56,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  controlButtonLarge: {
    width: 56,
    height: 56,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  controlButtonText: {
    color: colors.primary,
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '700',
    marginTop: 2
  },
  seekFeedback: {
    position: 'absolute',
    top: '50%',
    marginTop: -40,
    width: 80,
    height: 80,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: PLAYER_Z_INDEX.base
  },
  seekFeedbackLeft: {
    left: '15%'
  },
  seekFeedbackRight: {
    right: '15%'
  },
  seekFeedbackText: {
    color: colors.primary,
    fontSize: 14,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '600',
    marginTop: 4
  },
  minimizeButton: {
    position: 'absolute',
    left: 12,
    zIndex: PLAYER_Z_INDEX.base
  },
  minimizeButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: colors.overlayMedium,
    justifyContent: 'center',
    alignItems: 'center'
  },
  speedButton: {
    position: 'absolute',
    right: 12,
    zIndex: PLAYER_Z_INDEX.base
  },
  speedButtonInner: {
    minWidth: 50,
    height: 32,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10
  },
  speedButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600'
  },
  castButton: {
    position: 'absolute',
    right: 60,
    zIndex: PLAYER_Z_INDEX.base
  },
  castButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center'
  },
  fullscreenButton: {
    position: 'absolute',
    right: 12,
    zIndex: PLAYER_Z_INDEX.base
  },
  fullscreenButtonLandscape: {
    bottom: 16,
    right: 16
  },
  fullscreenButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center'
  },
  // ── Scrubber: Track layers (spec §1, §9) ──────────────────────────────
  scrubberTrackWrapper: {
    position: 'relative',
    height: 8
  },
  scrubberTrackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.borderLight
  },
  scrubberBufferFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.textDisabled
  },
  scrubberPlayedFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.primary
  },
  // ── Scrubber: Handle (spec §3) ───────────────────────────────────────
  scrubberHandleNew: {
    position: 'absolute',
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.primary
  },
  // ── Scrubber: Tooltip (spec §4) ──────────────────────────────────────
  scrubberTooltip: {
    position: 'absolute',
    left: 0,
    alignItems: 'center'
  },
  scrubberTooltipBubble: {
    backgroundColor: colors.surface,
    borderRadius: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 2,
    borderColor: colors.border
  } as any,
  scrubberTooltipText: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Regular',
    fontWeight: '400',
    textAlign: 'center',
    minWidth: 40
  } as any,
  scrubberTooltipArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderLeftColor: 'transparent',
    borderRightWidth: 6,
    borderRightColor: 'transparent',
    borderTopWidth: 6,
    borderTopColor: colors.surface,
    marginTop: -1,
    alignSelf: 'center'
  } as any,
  // Legacy thin progress bar styles kept for web fallback
  thinProgressBg: {
    height: 3,
    backgroundColor: colors.borderLight
  },
  thinProgressFill: {
    height: '100%',
    backgroundColor: colors.primary
  },
  timeDisplayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  timeTextCurrent: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'] as any
  } as any,
  timeTextMuted: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'] as any
  } as any,
  timeDisplayAction: {
    minWidth: 36,
    minHeight: 36,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.8
  },
  // Fullscreen progress bar (shown with controls)
  fullscreenProgressContainer: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: PLAYER_Z_INDEX.base
  },
  fullscreenProgressBar: {
    flex: 1,
    height: 24,
    justifyContent: 'center'
  },
  fullscreenProgressBg: {
    height: 4,
    backgroundColor: 'transparent',
    borderRadius: 2,
    overflow: 'hidden'
  },
  fullscreenProgressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2
  },
  seekHandle: {
    position: 'absolute',
    top: -5,
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.primary,
    marginLeft: -6
  },
  timeText: {
    minWidth: 40,
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 12,
    color: colors.text
  },
  // Mini player styles
  miniInfo: {
    position: 'absolute',
    left: MINI_PIP_WIDTH,
    right: 100,
    top: 0,
    height: MINI_PIP_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 12
  },
  miniInfoText: {
    flex: 1,
    justifyContent: 'center'
  },
  miniTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500'
  },
  miniChannel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2
  },
  miniControls: {
    position: 'absolute',
    right: 8,
    top: 0,
    height: MINI_PIP_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center'
  },
  miniControlButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center'
  },
  miniProgressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.borderSubtle
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: colors.primary
  },
  miniPipOverlay: {
    ...ABSOLUTE_FILL,
    backgroundColor: colors.overlayMedium,
    justifyContent: 'center',
    alignItems: 'center'
  },
  miniPipTopRow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  miniPipSmallButton: {
    width: 32,
    height: 32,
    borderRadius: 4,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center'
  },
  miniPipPlayPauseButton: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 40,
    height: 40,
    marginTop: -20,
    marginLeft: -20,
    borderRadius: 4,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center'
  } as any,
  miniPipControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16
  },
  miniPipSkipButton: {
    width: 32,
    height: 32,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center'
  },
  miniPipPlayButton: {
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: colors.overlayButton,
    justifyContent: 'center',
    alignItems: 'center'
  },
  miniPipProgressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: colors.borderLight
  },
  miniPipProgressFill: {
    height: '100%',
    backgroundColor: colors.primary
  },
  // Fullscreen content styles
  // Black background ensures PiP shows video + black (not video + colored content)
  // when native hideNonVideoContent hides the ScrollView
  fullscreenContent: {
    // Position is set by animated style (absolute with top: videoHeight)
    // No flex needed since we use explicit positioning
    backgroundColor: PLAYER_COLORS.black
  },
  scrollContent: {
    flex: 1,
    backgroundColor: PLAYER_COLORS.black
  },
  videoInfo: {
    padding: 16,
    backgroundColor: PLAYER_COLORS.black
  },
  videoTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24
  },
  videoMeta: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 6
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingVertical: 12,
    backgroundColor: PLAYER_COLORS.black,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border
  },
  actionButton: {
    width: '16.66%',
    minWidth: 56,
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 4,
  },
  actionLabel: {
    color: colors.text,
    fontSize: 11,
    marginTop: 4,
    maxWidth: '100%',
    textAlign: 'center',
    fontFamily: 'JetBrainsMono-Medium',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  actionLabelActive: {
    color: colors.primary
  },
  actionButtonActive: {
    borderColor: colors.primary,
  },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    padding: 12,
    borderRadius: 4,
    backgroundColor: colors.scrim,
    borderWidth: 1,
    borderColor: colors.border
  },
  toastTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2
  },
  toastText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16
  },
  channelAvatar: {
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center'
  },
  channelAvatarText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600'
  },
  channelInfo: {
    flex: 1,
    marginLeft: 12
  },
  channelName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500'
  },
  channelSubs: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2
  },
  subscribeButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 4
  },
  subscribeText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600'
  },
  divider: {
    height: 8,
    backgroundColor: colors.bgSecondary,
    marginVertical: 8
  },
  description: {
    padding: 16
  },
  descriptionText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20
  },
  // Comments styles
  commentsSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16
  },
  commentsTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10
  },
  commentsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary
  },
  refreshButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600'
  },
  replyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 4,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: colors.primary
  },
  replyIndicatorText: {
    color: colors.onPrimary,
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '500'
  },
  cancelReplyButton: {
    padding: 4
  },
  commentComposer: {
    backgroundColor: colors.surfaceHover,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 10,
    marginBottom: 12
  },
  commentInput: {
    color: colors.text,
    minHeight: 44,
    fontSize: 14,
    padding: 0
  },
  commentButton: {
    alignSelf: 'flex-end',
    marginTop: 10,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4
  },
  commentButtonText: {
    color: colors.onPrimary,
    fontFamily: 'Syne-Bold',
    fontWeight: '600',
    fontSize: 12,
    textTransform: 'uppercase'
  },
  commentsEmpty: {
    color: colors.textMuted,
    fontSize: 13,
    paddingVertical: 8
  },
  commentItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  commentRow: {
    flexDirection: 'row',
    gap: 12,
  },
  commentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 4,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarText: {
    fontSize: 14,
    fontFamily: 'Syne-Bold',
    fontWeight: '700',
    color: colors.primary,
  },
  commentContent: {
    flex: 1,
  },
  commentDivider: {
    height: 1,
    backgroundColor: colors.borderSubtle,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6
  },
  commentAuthor: {
    color: colors.text,
    fontSize: 13,
    fontFamily: 'Syne-Bold',
    fontWeight: '600',
    flex: 1
  },
  adminBadge: {
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    color: colors.primary,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '500'
  },
  pendingBadge: {
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: 'JetBrainsMono-Medium'
  },
  commentActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 'auto'
  },
  commentActionButton: {
    padding: 4
  },
  commentText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20
  },
  commentTextPending: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20
  },
  repliesContainer: {
    marginLeft: 20,
    marginTop: 8,
    gap: 0,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: 12
  },
  replyItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  loadMoreButton: {
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  loadMoreText: {
    color: colors.primary,
    fontSize: 13,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '500'
  },
  // P2P Stats Bar styles - Clean with all stats
  statsBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.overlayButton,
    borderRadius: 4,
    marginHorizontal: 12,
    marginTop: 8,
    borderWidth: 2,
    borderColor: colors.border
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  statsRowSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    justifyContent: 'space-between'
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  statsDivider: {
    width: 1,
    height: 12,
    backgroundColor: colors.borderLight,
    marginHorizontal: 10
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '500',
    fontFamily: 'JetBrainsMono-Medium',
    color: colors.textMuted,
    textTransform: 'uppercase'
  },
  statText: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Regular'
  },
  statSpeed: {
    color: colors.primary,
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '500'
  },
  statSpeedUp: {
    color: colors.success,
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Medium',
    fontWeight: '500'
  },
  statDetail: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular'
  },
  statProgress: {
    color: colors.text,
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    fontWeight: '500'
  },
  statProgressComplete: {
    color: colors.success
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  progressBarBg: {
    marginTop: 10,
    height: 4,
    backgroundColor: colors.borderLight,
    borderRadius: 2,
    overflow: 'hidden'
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.warning,
    borderRadius: 2
  }
  })
