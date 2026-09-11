import { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

type TagTone = 'default' | 'accent' | 'swarm' | 'danger' | 'success' | 'warning' | 'inverse'

const TAG_TONES: Record<TagTone, { fg: string; border: string; bg: string }> = {
  default: { fg: colors.textSecondary, border: colors.border, bg: 'transparent' },
  accent: { fg: colors.primary, border: colors.primary, bg: 'transparent' },
  swarm: { fg: colors.swarm, border: colors.swarm, bg: 'transparent' },
  danger: { fg: colors.error, border: colors.error, bg: 'transparent' },
  success: { fg: colors.success, border: colors.success, bg: 'transparent' },
  warning: { fg: colors.warning, border: colors.warning, bg: 'transparent' },
  // Solid lime slab, for badges laid over artwork (duration, LIVE, NEW).
  inverse: { fg: colors.onPrimary, border: colors.primary, bg: colors.primary },
}

interface TagProps {
  label: string
  tone?: TagTone
  icon?: keyof typeof Feather.glyphMap
  style?: StyleProp<ViewStyle>
  testID?: string
}

/** Small mono uppercase badge with a 1px rule. */
export function Tag({ label, tone = 'default', icon, style, testID }: TagProps) {
  const palette = TAG_TONES[tone]
  return (
    <View
      style={[styles.tag, { borderColor: palette.border, backgroundColor: palette.bg }, style]}
      testID={testID}
    >
      {icon ? <Feather name={icon} size={10} color={palette.fg} style={styles.tagIcon} /> : null}
      <Text style={[styles.tagLabel, { color: palette.fg }]}>{label}</Text>
    </View>
  )
}

interface DividerProps {
  /** `rule` is the 2px structural line; `hairline` is 1px. */
  weight?: 'rule' | 'hairline'
  tone?: 'default' | 'accent'
  style?: StyleProp<ViewStyle>
}

/** Horizontal rule. */
export function Divider({ weight = 'hairline', tone = 'default', style }: DividerProps) {
  return (
    <View
      style={[
        {
          height: borderWidth[weight],
          backgroundColor: tone === 'accent' ? colors.primary : weight === 'rule' ? colors.border : colors.borderSubtle,
        },
        style,
      ]}
    />
  )
}

interface IconButtonProps {
  icon: keyof typeof Feather.glyphMap
  onPress?: () => void
  accessibilityLabel: string
  size?: number
  /** `outline` draws the 2px rule; `plain` is glyph-only. */
  variant?: 'outline' | 'plain' | 'primary'
  active?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  testID?: string
}

/** Square glyph button. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 40,
  variant = 'outline',
  active = false,
  disabled = false,
  style,
  testID,
}: IconButtonProps) {
  const fg = variant === 'primary' ? colors.onPrimary : active ? colors.primary : colors.text
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size },
        variant === 'outline' && { borderWidth: borderWidth.rule, borderColor: active ? colors.primary : colors.border },
        variant === 'primary' && { backgroundColor: colors.primary },
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.35 },
        style,
      ]}
    >
      <Feather name={icon} size={Math.round(size * 0.45)} color={fg} />
    </Pressable>
  )
}

interface ScreenHeaderProps {
  title: string
  /** Mono kicker above the title, e.g. `LIBRARY / 03`. */
  eyebrow?: string
  /** Renders a back chevron on the leading edge. */
  onBack?: () => void
  /** Trailing controls. */
  right?: ReactNode
  /** Removes the bottom rule for screens whose first child draws its own. */
  flushBottom?: boolean
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * Screen title bar: optional back glyph, mono eyebrow, uppercase display
 * title, trailing controls, 2px rule underneath.
 */
export function ScreenHeader({ title, eyebrow, onBack, right, flushBottom = false, style, testID }: ScreenHeaderProps) {
  return (
    <View style={[styles.header, !flushBottom && styles.headerRule, style]} testID={testID}>
      {onBack ? (
        <IconButton icon="arrow-left" onPress={onBack} accessibilityLabel="Back" variant="plain" size={36} style={styles.back} />
      ) : null}
      <View style={styles.headerTitles}>
        {eyebrow ? <Text style={styles.headerEyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm - 2,
    height: 20,
    borderWidth: borderWidth.hairline,
    borderRadius: radius.sm,
  },
  tagIcon: {
    marginRight: spacing.xs,
  },
  tagLabel: {
    ...fonts.caption.sm,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1,
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    minHeight: 60,
  },
  headerRule: {
    borderBottomWidth: borderWidth.rule,
    borderBottomColor: colors.border,
  },
  back: {
    marginLeft: -spacing.sm,
    marginRight: spacing.sm,
  },
  headerTitles: {
    flex: 1,
    justifyContent: 'center',
  },
  headerEyebrow: {
    ...fonts.caption.sm,
    color: colors.primary,
    marginBottom: 2,
  },
  headerTitle: {
    ...fonts.title.lg,
    color: colors.text,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.md,
    gap: spacing.sm,
  },
})
