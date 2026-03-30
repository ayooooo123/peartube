# PEARTUBE PLAYER REDESIGN — FINAL SPECIFICATION
## Consolidated from Design Proposals 1 (Product Design), 2 (Engineering), 3 (UX Research)
## Date: March 2026 — IMPLEMENTATION-READY

---

## 1. PROGRESS BAR

### Container (Touch Target)
```
height: 48px
paddingHorizontal: 16px
justifyContent: 'center'
position: 'absolute'
bottom: 36px
left: 0
right: 0
```

### Track (Visible Bar) — Three States
```
REST STATE:
  height: 4px
  borderRadius: 2px

TOUCH STATE (finger down, not yet dragging):
  height: 6px
  borderRadius: 3px

SCRUBBING STATE (actively dragging):
  height: 8px
  borderRadius: 4px
```

### Track Colors
```
Background (unbuffered):  rgba(255, 255, 255, 0.15)
Buffer fill (downloaded): rgba(145, 71, 255, 0.35)
Played fill (watched):    #9147ff
```

All three layers are absolutely positioned within the track, stacked bottom-to-top:
background → buffer → played. All layers share the same height and borderRadius,
animated in sync.

---

## 2. BUFFER INDICATOR

### Standard (Contiguous Buffer)
```
Single view:
  position: 'absolute'
  left: 0, top: 0
  height: '100%'
  width: bufferProgress * 100 + '%'
  backgroundColor: 'rgba(145, 71, 255, 0.35)'
  borderRadius: matches track borderRadius
```

### P2P Non-Contiguous Buffer (Multiple Segments)
```
Each segment:
  position: 'absolute'
  top: 0
  left: segment.start * trackWidth
  width: (segment.end - segment.start) * trackWidth
  height: '100%'
  backgroundColor: 'rgba(145, 71, 255, 0.35)'
  borderRadius: matches track borderRadius
```

When buffer ranges are unavailable, fall back to single linear bar.

### Active Download Shimmer
```
When buffer is actively growing (not 100% cached):
  Leading edge of buffer pulses opacity 0.25 → 0.45
  Duration: 800ms
  Animation: withRepeat(withTiming(opacity, { duration: 800 }), -1, true)
  Disabled when prefers-reduced-motion is set
  Stops when fully cached (100%)
```

---

## 3. SCRUBBER HANDLE

### Rest State (Always Visible When Controls Shown)
```
width: 12px
height: 12px
borderRadius: 6px
backgroundColor: '#FFFFFF'
opacity: 1.0
shadowColor: '#000000'
shadowOffset: { width: 0, height: 1 }
shadowOpacity: 0.40
shadowRadius: 3
elevation: 4
```

### Active/Scrubbing State
```
width: 18px
height: 18px
borderRadius: 9px
backgroundColor: '#FFFFFF'
opacity: 1.0
borderWidth: 2
borderColor: 'rgba(145, 71, 255, 0.50)'
shadowColor: '#000000'
shadowOffset: { width: 0, height: 1 }
shadowOpacity: 0.50
shadowRadius: 5
elevation: 6
```

### Why White (Not Purple)
White handle on purple fill = ~6:1 contrast ratio. Purple handle on purple
fill = ~1:1. White is always visible and signals "grab me."

The handle is ALWAYS visible when controls are shown. It transitions between
rest (12px) and active (18px) states — it never disappears or becomes a ghost.

---

## 4. TIME DISPLAY

### Format
```
Combined left-aligned: "2:34 / 12:05"
For videos ≥1hr: "1:02:34 / 2:15:00"
```

### Layout
```
Container:
  position: 'absolute'
  bottom: 12px
  left: 16px
  right: 16px
  flexDirection: 'row'
  justifyContent: 'space-between'
  alignItems: 'center'

Left side — Time text:
  fontSize: 12
  fontWeight: '500'
  fontVariant: ['tabular-nums']
  Current time color: '#efeff1'
  Slash and duration color: '#7a7a85'

Right side — Fullscreen toggle:
  icon: 'maximize' (Feather)
  size: 20
  color: '#efeff1'
  opacity: 0.8
  padding: 8px (tap target ≥ 36px)
```

### Scrubbing Time Preview Tooltip
```
Container:
  backgroundColor: '#1f1f23'
  borderRadius: 8px
  paddingHorizontal: 10px
  paddingVertical: 6px
  borderWidth: 1
  borderColor: 'rgba(48, 48, 53, 0.8)'
  shadowColor: '#000000'
  shadowOffset: { width: 0, height: 2 }
  shadowOpacity: 0.50
  shadowRadius: 6
  Position: centered above handle, 12px gap above track
  Clamped horizontally to stay within 16px screen inset

Text:
  color: '#efeff1'
  fontSize: 13
  fontWeight: '600'
  fontVariant: ['tabular-nums']
  letterSpacing: 0.3

Arrow (pointing down):
  width: 0, height: 0
  borderLeftWidth: 6, borderLeftColor: 'transparent'
  borderRightWidth: 6, borderRightColor: 'transparent'
  borderTopWidth: 6, borderTopColor: '#1f1f23'
```

---

## 5. GESTURE BEHAVIOR

### Touch Target
```
Visible track: height 4-8px, inset 16px from edges
Touch container: height 48px, full width
hitSlop: { top: 20, bottom: 20, left: 0, right: 0 }
```

### Pan Gesture Config
```javascript
Gesture.Pan()
  .activateAfterLongPress(0)
  .minDistance(0)
  .hitSlop({ top: 20, bottom: 20 })
  .shouldCancelWhenOutside(false)
```

### Position Calculation
```
TRACK_PADDING = 16
x = e.absoluteX - TRACK_PADDING
trackW = containerWidth - TRACK_PADDING * 2
progress = clamp(x / trackW, 0, maxSeekable)

maxSeekable = isLive ? bufferProgress : 1.0
```

### Fine Scrubbing (Vertical Drift)
```
When finger moves vertically away from bar during scrub:
  verticalDistance > 80px → 0.25x speed (quarter-speed fine scrub)
  verticalDistance > 40px → 0.5x speed (half-speed fine scrub)
  verticalDistance ≤ 40px → 1.0x speed (normal)
```

### Edge Handling
```
Seeking past start: clamp to 0, progress stays at 0
Seeking past end: clamp to maxSeekable
Tap-to-seek: handled in onBegin (no drag needed)
Gesture cancellation: onFinalize resets isScrubbing and isTouching to 0
```

### Haptic Feedback
```
Touch down on track:       Haptics.impactAsync(Light)
Begin scrubbing (pan):     Haptics.impactAsync(Medium)
Hit start (0:00):          Haptics.impactAsync(Heavy)
Hit end:                   Haptics.impactAsync(Heavy)
Release / seek complete:   Haptics.impactAsync(Light)
Minute boundary crossed:   Haptics.selectionAsync()
  - Videos < 2min: fire every 10 seconds
  - Videos 2-30min: fire every 1 minute
  - Videos > 30min: fire every 5 minutes
Chapter marker crossed:    Haptics.impactAsync(Light)
```

---

## 6. ACTION BUTTONS

### Layout: Horizontal Pill Buttons
```
Row container:
  flexDirection: 'row'
  paddingHorizontal: 16px
  paddingVertical: 12px
  gap: 10px

Individual pill:
  flexDirection: 'row'
  alignItems: 'center'
  backgroundColor: '#1f1f23'
  borderRadius: 20px
  paddingHorizontal: 14px
  paddingVertical: 8px
  gap: 6px
  minHeight: 36px

Icon: size 18, color '#efeff1'
Label: fontSize 13, fontWeight '500', color '#efeff1'

Active/pressed state:
  backgroundColor: 'rgba(145, 71, 255, 0.15)'
```

### Like/Dislike Combined Pill
```
Combined container:
  flexDirection: 'row'
  backgroundColor: '#1f1f23'
  borderRadius: 20px
  overflow: 'hidden'

Like section (left):
  paddingHorizontal: 14px
  paddingVertical: 8px
  borderRightWidth: 1
  borderRightColor: '#303035'
  icon: thumbs-up + count (e.g., "1.2K")
  Active: iconColor '#9147ff', bg 'rgba(145, 71, 255, 0.15)'

Dislike section (right):
  paddingHorizontal: 12px
  paddingVertical: 8px
  icon: thumbs-down only (no count)
```

### Other Buttons
```
Share:    icon share,    label "Share"
Download: icon download, label "Save"
More:     icon more-horizontal, NO label, paddingHorizontal: 10px
```

---

## 7. MINI PLAYER

### Progress Bar in Mini State
```
Position: absolute top: 0, left: 0, right: 0
Height: 2px
Border radius: 0 (flush edge-to-edge)
No handle visible
No touch interaction (tap mini player to expand)
```

### Colors (Mini)
```
Background track:  rgba(255, 255, 255, 0.1)
Buffer fill:       rgba(255, 255, 255, 0.2)
Played fill:       #9147ff
```

No gap visualization in mini state (too small at 2px). Single linear buffer bar only.

### Full → Mini Transition
```
Two separate components that cross-fade:
  Full scrubber opacity: fades 1→0 over playerExpansion [0.3, 0.5]
  Mini bar opacity: fades 0→1 over playerExpansion [0.0, 0.2]
```

---

## 8. ANIMATION SPECS

### All Animations in One Table

| Animation             | Type   | Config                                          | Settle Time |
|-----------------------|--------|-------------------------------------------------|-------------|
| Track expand (touch)  | Spring | damping: 15, stiffness: 350, mass: 0.8          | ~120ms      |
| Track collapse        | Spring | damping: 15, stiffness: 350, mass: 0.8          | ~120ms      |
| Handle grow           | Spring | damping: 20, stiffness: 400, mass: 0.6, overshootClamping: true | ~80ms |
| Handle shrink         | Timing | duration: 200ms, easing: Easing.out(Easing.cubic) | 200ms     |
| Preview bubble appear | Spring | damping: 18, stiffness: 300, mass: 0.7          | ~100ms      |
| Preview bubble exit   | Timing | duration: 100ms, easing: Easing.in(Easing.cubic) | 100ms      |
| Buffer fill update    | Timing | duration: 300ms, easing: Easing.out(Easing.quad) | 300ms      |
| Progress fill         | Direct | No animation — direct assignment follows finger  | 0ms         |
| Controls fade in      | Timing | duration: 200ms, easing: Easing.out(Easing.quad) | 200ms      |
| Controls fade out     | Timing | duration: 300ms, easing: Easing.in(Easing.quad)  | 300ms      |
| Buffer shimmer        | Repeat | duration: 800ms, alternating, opacity 0.25↔0.45  | continuous  |
| Play/pause icon pop   | Spring | scale 1.0→1.15→1.0, Easing.out(Easing.back(1.5)) | 250ms      |

### Controls Auto-Hide
```
Timeout: 4 seconds of no interaction
While scrubbing: auto-hide is suspended
Reset timer on any touch event
```

### Gradient Overlays
```
Top gradient:
  height: 120px
  colors: ['rgba(0,0,0,0.7)', 'rgba(0,0,0,0)']

Bottom gradient:
  height: 160px
  colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.8)']
```

---

## 9. STYLE DEFINITIONS — React Native StyleSheet

```javascript
import { StyleSheet } from 'react-native';

export const COLORS = {
  trackBackground: 'rgba(255, 255, 255, 0.15)',
  bufferFill: 'rgba(145, 71, 255, 0.35)',
  playedFill: '#9147ff',
  handle: '#FFFFFF',
  handleGlow: 'rgba(145, 71, 255, 0.50)',
  tooltipBg: '#1f1f23',
  tooltipBorder: 'rgba(48, 48, 53, 0.8)',
  tooltipText: '#efeff1',
  textPrimary: '#efeff1',
  textMuted: '#7a7a85',
  cardBg: '#1f1f23',
  pillActive: 'rgba(145, 71, 255, 0.15)',
  pillDivider: '#303035',
  miniTrackBg: 'rgba(255, 255, 255, 0.1)',
  miniBufferFill: 'rgba(255, 255, 255, 0.2)',
};

export const DIMENSIONS = {
  TRACK_PADDING: 16,
  TRACK_HEIGHT_REST: 4,
  TRACK_HEIGHT_TOUCH: 6,
  TRACK_HEIGHT_SCRUB: 8,
  HANDLE_SIZE_REST: 12,
  HANDLE_SIZE_ACTIVE: 18,
  TOUCH_TARGET_HEIGHT: 48,
  MINI_BAR_HEIGHT: 2,
  CONTROLS_AUTO_HIDE_MS: 4000,
};

export const progressBarStyles = StyleSheet.create({
  // Touch target container
  container: {
    height: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
  },

  // Track background (Layer 1)
  trackBackground: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },

  // Buffer fill (Layer 2)
  bufferFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(145, 71, 255, 0.35)',
  },

  // Buffer segment (P2P non-contiguous)
  bufferSegment: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: 'rgba(145, 71, 255, 0.35)',
  },

  // Played fill (Layer 3)
  playedFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#9147ff',
  },

  // Handle — rest state
  handle: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.40,
    shadowRadius: 3,
    elevation: 4,
  },

  // Handle — active state (applied via animated style)
  handleActive: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: 'rgba(145, 71, 255, 0.50)',
    shadowOpacity: 0.50,
    shadowRadius: 5,
    elevation: 6,
  },

  // Time preview tooltip
  tooltip: {
    position: 'absolute',
    backgroundColor: '#1f1f23',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(48, 48, 53, 0.8)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.50,
    shadowRadius: 6,
    elevation: 8,
  },

  tooltipText: {
    color: '#efeff1',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  tooltipArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderLeftColor: 'transparent',
    borderRightWidth: 6,
    borderRightColor: 'transparent',
    borderTopWidth: 6,
    borderTopColor: '#1f1f23',
    alignSelf: 'center',
  },

  // Time display row
  timeContainer: {
    position: 'absolute',
    bottom: 12,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  currentTime: {
    fontSize: 12,
    fontWeight: '500',
    color: '#efeff1',
  },

  duration: {
    fontSize: 12,
    fontWeight: '500',
    color: '#7a7a85',
  },

  // Mini player progress bar
  miniProgressContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
  },

  miniTrackBackground: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },

  miniBufferFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },

  miniPlayedFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 2,
    backgroundColor: '#9147ff',
  },

  // Action button pill
  actionButtonRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },

  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f1f23',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    minHeight: 36,
  },

  actionPillActive: {
    backgroundColor: 'rgba(145, 71, 255, 0.15)',
  },

  actionPillIcon: {
    color: '#efeff1',
  },

  actionPillLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#efeff1',
  },

  // Combined like/dislike pill
  combinedPill: {
    flexDirection: 'row',
    backgroundColor: '#1f1f23',
    borderRadius: 20,
    overflow: 'hidden',
  },

  combinedPillLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    borderRightWidth: 1,
    borderRightColor: '#303035',
  },

  combinedPillRight: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  // P2P stats chip
  statsChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.50)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },

  statsChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4ade80',
  },

  statsChipText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#efeff1',
  },

  // Gradient overlays
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
  },

  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 160,
  },
});

// Animation config constants
export const ANIM_CONFIGS = {
  TRACK_SPRING: {
    damping: 15,
    stiffness: 350,
    mass: 0.8,
    restDisplacementThreshold: 0.01,
    restSpeedThreshold: 0.01,
  },
  HANDLE_SPRING: {
    damping: 20,
    stiffness: 400,
    mass: 0.6,
    overshootClamping: true,
  },
  HANDLE_EXIT: {
    duration: 200,
    easing: Easing.out(Easing.cubic),
  },
  PREVIEW_SPRING: {
    damping: 18,
    stiffness: 300,
    mass: 0.7,
  },
  PREVIEW_EXIT: {
    duration: 100,
    easing: Easing.in(Easing.cubic),
  },
  BUFFER_TIMING: {
    duration: 300,
    easing: Easing.out(Easing.quad),
  },
  CONTROLS_FADE_IN: {
    duration: 200,
    easing: Easing.out(Easing.quad),
  },
  CONTROLS_FADE_OUT: {
    duration: 300,
    easing: Easing.in(Easing.quad),
  },
};
```

---

## 10. ACCESSIBILITY CHECKLIST

```
[x] Touch target ≥ 44px in all directions (48px container + 20px hitSlop)
[x] Fill-to-background contrast ≥ 3:1 (#9147ff on effective ~#262626)
[x] Handle-to-fill contrast ≥ 3:1 (white on purple = ~6:1)
[x] accessibilityRole="adjustable"
[x] accessibilityLabel="Video progress"
[x] accessibilityValue={{ min: 0, max: duration, now: currentTime }}
[x] Increment/decrement actions: 10-second jumps
[x] prefers-reduced-motion: skip transitions, show expanded state immediately
[x] Focus ring: 2px white outline on handle when focused via assistive tech
[x] Shimmer animation disabled under reduced motion
```

---

## DESIGN DECISIONS LOG

| Decision | Chosen | Why | Rejected Alternatives |
|----------|--------|-----|----------------------|
| Track rest height | 4px | Industry standard (Disney+, Netflix, Spotify). 3px (P2) too thin for mobile-first. 5px (P3) slightly too thick at rest. | 3px (P2), 5px (P3) |
| Track scrub height | 8px | Strong tactile expansion (P1, P3 consensus). 7px (P2) too close to touch state. | 7px (P2) |
| Handle rest size | 12px | Always visible, good discoverability (P1). 6px ghost (P2) too hidden. 14px (P3) slightly oversized at rest. | 6px ghost (P2), 14px (P3) |
| Handle visibility | Always visible | P1+P3 consensus. Ghost handle (P2) reduces discoverability. Industry best: Spotify always-visible. | Ghost at 40% opacity (P2) |
| Buffer color | Purple tint rgba(145,71,255,0.35) | On-brand, distinguishes from generic white buffer. P1+P3 consensus. White buffer (P2) loses brand identity. | White rgba(255,255,255,0.35) (P2) |
| Track animation | Spring (P2 configs) | Springs feel more natural than timing for physical expansion. P2 has production-tested configs. | Timing 150ms (P1) |
| Handle animation | Spring appear, timing exit | Snappy appear (spring), gentle settle (timing). Best of P2. | All timing (P1) |
| Time format | "2:34 / 12:05" combined left | Frees right side for fullscreen button (P1). Cleaner than split sides. | Separate left/right (P1 alt) |
| Handle glow on scrub | Purple border ring | Adds visual feedback without complexity (P1). More subtle than full glow (P3). | Purple shadow glow (P3) |
| Action buttons | Combined like/dislike pill + separate pills | Modern, proven pattern (YouTube 2023). P1 proposal. | Stacked icon+label grid (current) |
| Mini player bar | 2px, edge-to-edge, no handle | P2 spec. Clean, minimal, appropriate for collapsed state. | N/A |
| Auto-hide timeout | 4 seconds | Between Netflix (3s, too fast) and YouTube (5s, too slow). P1 recommendation. | 3s, 5s |

---

*This specification merges Product Design (Proposal 1), Engineering (Proposal 2), and UX Research (Proposal 3) perspectives. Every value is final and implementation-ready. No ranges — single values only.*
