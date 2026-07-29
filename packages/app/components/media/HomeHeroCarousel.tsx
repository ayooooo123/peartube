import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import type { MediaEntitySummary } from '@peartube/core'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { usePosterArtwork } from '@/hooks/usePosterArtwork'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

export type HomeHeroItem = MediaEntitySummary & Record<string, unknown>

export type HomeHeroCarouselProps = {
  items: HomeHeroItem[]
  /** Window width. The carousel centres a 90%-wide slide inside it. */
  windowWidth: number
  onOpenEntity(entityId: string, item: HomeHeroItem): void
}

const HERO_WIDTH_FRACTION = 0.9
// A full-bleed 16:9 banner swallows a desktop monitor; cap it and let the
// centring padding recentre the narrower slide.
const HERO_MAX_WIDTH = 720
const HERO_GAP = spacing.md
const HERO_ROTATE_MS = 5_000

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function heroCaption(item: HomeHeroItem): string | null {
  const year = typeof item.releaseYear === 'number' && item.releaseYear > 0 ? String(item.releaseYear) : null
  const subtitle = pickString(item.subtitle)
  if (year && subtitle) return `${year} · ${subtitle}`
  return year || subtitle
}

const OVERLAY_GRADIENT = ['rgba(0,0,0,0)', 'rgba(0,0,0,0.6)', 'rgba(0,0,0,0.95)'] as const
const OVERLAY_LOCATIONS = [0, 0.6, 1] as const

/**
 * One slide.
 *
 * A landscape source gets MediaStorm's treatment: the still fills the frame and
 * the title sits over a gradient ramp at the bottom.
 *
 * A portrait-only title does NOT. Cropping a 2:3 poster into a 16:9 frame is
 * exactly what got the previous feature panel reverted - it cuts the top and
 * bottom off the artwork. Letterboxing it instead would leave the poster as a
 * narrow strip flanked by two thirds of dead frame, so the slide switches
 * layout: the whole uncropped poster stands at full height on the left and the
 * title and metadata take the space beside it. Nothing is cut off, and the
 * frame is still full.
 */
function HeroSlide({
  item,
  width,
  onOpenEntity,
}: {
  item: HomeHeroItem
  width: number
  onOpenEntity(entityId: string, item: HomeHeroItem): void
}) {
  // Stable across renders, so the memo around this slide is worth having.
  const onPress = useCallback(() => onOpenEntity(item.entityId, item), [item, onOpenEntity])
  // Cover art claimed as a blob is a portrait poster, and usePosterArtwork
  // resolves that in preference to any locator handed to it, so a title with a
  // claim is portrait no matter what else the catalog names.
  const claimsPosterBlob = pickString(item.posterBlobId, item.posterBlobsCoreKey) !== null
  // Backdrops and episode stills are 16:9; poster fields are deliberately not
  // in this chain.
  const backdrop = claimsPosterBlob
    ? null
    : pickString(item.backdropUrl, item.stillUrl, item.thumbnailUrl, item.thumbnail)
  const artwork = usePosterArtwork(
    item,
    backdrop ?? pickString(item.posterUrl, item.thumbnailUrl, item.thumbnail, item.stillUrl, item.backdropUrl),
  )
  const title = pickString(item.title) || 'Untitled'
  const caption = heroCaption(item)
  const initial = title.charAt(0).toUpperCase()

  if (backdrop === null) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={onPress}
        style={({ pressed }) => [styles.slide, { width }, pressed && styles.slidePressed]}
      >
        <View style={styles.posterPanel}>
          <View style={styles.posterFrame}>
            <ThumbnailImage thumbnailUrl={artwork} channelInitial={initial} style={styles.fill} />
          </View>
          <View style={styles.posterText}>
            <Text style={styles.title} numberOfLines={2}>{title}</Text>
            {caption ? <Text style={styles.caption} numberOfLines={2}>{caption}</Text> : null}
          </View>
        </View>
      </Pressable>
    )
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.slide, { width }, pressed && styles.slidePressed]}
    >
      <ThumbnailImage thumbnailUrl={artwork} channelInitial={initial} style={styles.fill} />
      <LinearGradient
        colors={OVERLAY_GRADIENT}
        locations={OVERLAY_LOCATIONS}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.overlayGradient}
      />
      <View style={styles.overlayText}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {caption ? <Text style={styles.caption} numberOfLines={2}>{caption}</Text> : null}
      </View>
    </Pressable>
  )
}

const MemoizedHeroSlide = memo(HeroSlide)

export function HomeHeroCarousel({ items, windowWidth, onOpenEntity }: HomeHeroCarouselProps) {
  const scrollRef = useRef<ScrollView>(null)
  const indexRef = useRef(0)
  const [index, setIndex] = useState(0)
  // A viewer who took hold of the carousel is browsing it; nothing should move
  // under their thumb after that.
  const [userDriven, setUserDriven] = useState(false)

  const { slideWidth, snapInterval, contentStyle } = useMemo(() => {
    const width = Math.max(1, Math.min(Math.round(windowWidth * HERO_WIDTH_FRACTION), HERO_MAX_WIDTH))
    return {
      slideWidth: width,
      snapInterval: width + HERO_GAP,
      // Centres the first and last slide instead of pinning them to the edge.
      contentStyle: {
        paddingHorizontal: Math.max(0, Math.round((windowWidth - width) / 2)),
        gap: HERO_GAP,
      },
    }
  }, [windowWidth])

  const goTo = useCallback((next: number) => {
    indexRef.current = next
    setIndex(next)
    scrollRef.current?.scrollTo({ x: next * snapInterval, y: 0, animated: true })
  }, [snapInterval])

  const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / snapInterval)
    if (next === indexRef.current || next < 0 || next >= items.length) return
    indexRef.current = next
    setIndex(next)
  }, [items.length, snapInterval])

  useEffect(() => {
    if (userDriven || items.length < 2) return
    const timer = setTimeout(() => goTo((indexRef.current + 1) % items.length), HERO_ROTATE_MS)
    return () => clearTimeout(timer)
  }, [goTo, index, items.length, userDriven])

  if (items.length === 0) return null

  return (
    <View testID="home-hero" style={styles.container}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={snapInterval}
        snapToAlignment="start"
        decelerationRate="fast"
        onScrollBeginDrag={() => setUserDriven(true)}
        onMomentumScrollEnd={onMomentumScrollEnd}
        contentContainerStyle={contentStyle}
      >
        {items.map(item => (
          <MemoizedHeroSlide
            key={item.entityId}
            item={item}
            width={slideWidth}
            onOpenEntity={onOpenEntity}
          />
        ))}
      </ScrollView>
      {items.length > 1 ? (
        <View style={styles.pagination}>
          {items.map((item, dotIndex) => (
            <Pressable
              key={item.entityId}
              accessibilityRole="button"
              accessibilityLabel={`Show featured title ${dotIndex + 1}`}
              hitSlop={{ top: 10, bottom: 10, left: 5, right: 5 }}
              onPress={() => { setUserDriven(true); goTo(dotIndex) }}
              style={[styles.dot, dotIndex === index && styles.dotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.lg,
  },
  slide: {
    aspectRatio: 16 / 9,
    borderRadius: radius.card,
    backgroundColor: colors.bgElevated,
    overflow: 'hidden',
  },
  slidePressed: {
    opacity: 0.85,
  },
  // ThumbnailImage imposes a 16:9 video still by default, which is what the
  // landscape slide wants and what the poster frame below has to override.
  fill: {
    width: '100%',
    height: '100%',
    aspectRatio: undefined,
    borderRadius: 0,
  },
  overlayGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
  },
  overlayText: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    gap: spacing.xs,
  },
  posterPanel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.lg,
  },
  posterFrame: {
    height: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radius.md,
    backgroundColor: colors.bgHover,
    overflow: 'hidden',
  },
  posterText: {
    flex: 1,
    gap: spacing.xs,
    paddingRight: spacing.xs,
  },
  title: {
    ...fonts.title.md,
    fontFamily: fonts.heading,
    color: colors.text,
  },
  caption: {
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  pagination: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.overlayButton,
  },
  dotActive: {
    width: 20,
    backgroundColor: colors.primary,
  },
})
