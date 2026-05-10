import {
  MINI_PIP_MARGIN,
  MINI_PIP_COMPACT_WIDTH_FRACTION,
  MINI_PIP_COMPACT_WIDTH_MIN,
  MINI_PIP_COMPACT_WIDTH_MAX,
  MINI_PIP_EXPANDED_WIDTH_FRACTION,
  MINI_PIP_EXPANDED_WIDTH_MIN,
  MINI_PIP_EXPANDED_WIDTH_MAX,
  SNAP_LOW_SPEED,
  SNAP_FLING_SPEED,
  SNAP_TOSS_HORIZON,
  SNAP_FLING_HORIZON,
  SNAP_HYSTERESIS_PX,
} from './constants'

export type MiniPlayerCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface MiniBounds {
  leftBound: number
  rightBound: number
  topBound: number
  bottomBound: number
}

export interface Anchor { x: number; y: number; corner: MiniPlayerCorner }

export function computeMiniSize(screenWidth: number, aspectRatio: number, sizeMode: 'compact' | 'expanded' = 'compact') {
  'worklet'
  const ar = aspectRatio > 0 ? aspectRatio : 16 / 9
  const fraction = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_FRACTION : MINI_PIP_COMPACT_WIDTH_FRACTION
  const minW = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_MIN : MINI_PIP_COMPACT_WIDTH_MIN
  const maxW = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_MAX : MINI_PIP_COMPACT_WIDTH_MAX
  const w = Math.max(minW, Math.min(maxW, Math.round(screenWidth * fraction)))
  const h = Math.round(w / ar)
  return { width: w, height: h }
}

export function computeMiniBounds(
  screenWidth: number,
  screenHeight: number,
  insetTop: number,
  insetRight: number,
  insetBottom: number,
  insetLeft: number,
  bottomChrome: number,
  miniWidth: number,
  miniHeight: number,
): MiniBounds {
  'worklet'
  const margin = MINI_PIP_MARGIN
  const bottomMargin = Math.max(insetBottom + margin, bottomChrome + margin)
  return {
    leftBound: insetLeft + margin,
    rightBound: screenWidth - insetRight - margin - miniWidth,
    topBound: insetTop + margin,
    bottomBound: screenHeight - bottomMargin - miniHeight,
  }
}

export function getCornerAnchors(bounds: MiniBounds): [Anchor, Anchor, Anchor, Anchor] {
  'worklet'
  return [
    { x: bounds.leftBound,  y: bounds.topBound,    corner: 'top-left' },
    { x: bounds.rightBound, y: bounds.topBound,    corner: 'top-right' },
    { x: bounds.leftBound,  y: bounds.bottomBound, corner: 'bottom-left' },
    { x: bounds.rightBound, y: bounds.bottomBound, corner: 'bottom-right' },
  ]
}

export function resolveSnapTarget(
  releaseX: number,
  releaseY: number,
  vx: number,
  vy: number,
  anchors: readonly Anchor[],
  miniWidth: number,
  miniHeight: number,
  currentCorner: MiniPlayerCorner,
  bounds: MiniBounds,
): Anchor {
  'worklet'
  const speed = Math.sqrt(vx * vx + vy * vy)

  let horizon = 0
  if (speed >= SNAP_FLING_SPEED) {
    horizon = SNAP_FLING_HORIZON
  } else if (speed >= SNAP_LOW_SPEED) {
    horizon = SNAP_TOSS_HORIZON
  }

  let targetX = releaseX + vx * horizon
  let targetY = releaseY + vy * horizon
  targetX = Math.max(bounds.leftBound, Math.min(bounds.rightBound, targetX))
  targetY = Math.max(bounds.topBound, Math.min(bounds.bottomBound, targetY))

  const tcx = targetX + miniWidth / 2
  const tcy = targetY + miniHeight / 2
  let bestAnchor = anchors[0]
  let bestScore = Infinity
  let currentAnchorScore = Infinity

  for (let i = 0; i < anchors.length; i++) {
    const acx = anchors[i].x + miniWidth / 2
    const acy = anchors[i].y + miniHeight / 2
    const score = (acx - tcx) * (acx - tcx) + (acy - tcy) * (acy - tcy)
    if (score < bestScore) {
      bestScore = score
      bestAnchor = anchors[i]
    }
    if (anchors[i].corner === currentCorner) {
      currentAnchorScore = score
    }
  }

  if (speed < SNAP_LOW_SPEED && currentAnchorScore < Infinity) {
    const bestDist = Math.sqrt(bestScore)
    const currentDist = Math.sqrt(currentAnchorScore)
    if (currentDist - bestDist < SNAP_HYSTERESIS_PX) {
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i].corner === currentCorner) return anchors[i]
      }
    }
  }

  return bestAnchor
}

export function getMobileMiniPlayerSnapPosition({
  corner,
  screenWidth,
  screenHeight,
  topInset,
  rightInset,
  bottomInset,
  leftInset,
  bottomOffset,
  aspectRatio,
  sizeMode,
}: {
  corner: MiniPlayerCorner
  screenWidth: number
  screenHeight: number
  topInset: number
  rightInset: number
  bottomInset: number
  leftInset: number
  bottomOffset: number
  aspectRatio: number
  sizeMode: 'compact' | 'expanded'
}) {
  const { width: miniWidth, height: miniHeight } = computeMiniSize(screenWidth, aspectRatio, sizeMode)
  const bounds = computeMiniBounds(
    screenWidth,
    screenHeight,
    topInset,
    rightInset,
    bottomInset,
    leftInset,
    bottomOffset,
    miniWidth,
    miniHeight,
  )
  const anchors = getCornerAnchors(bounds)
  const anchor = anchors.find(a => a.corner === corner) ?? anchors[3]
  return { x: anchor.x, y: anchor.y, width: miniWidth, height: miniHeight }
}
