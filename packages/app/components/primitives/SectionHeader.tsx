import { Pressable, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

interface SectionHeaderProps {
  title: string
  /** Mono kicker rendered above the title, e.g. `01 / LIVE NOW`. */
  eyebrow?: string
  subtitle?: string
  action?: { label: string; onPress: () => void }
  /** Removes the horizontal gutter for callers that already pad. */
  flush?: boolean
  style?: StyleProp<ViewStyle>
}

/**
 * Section title block: lime rule on the leading edge, uppercase Syne title,
 * optional mono eyebrow and a trailing mono action (`LABEL →`).
 */
export function SectionHeader({ title, eyebrow, subtitle, action, flush = false, style }: SectionHeaderProps) {
  return (
    <View style={[styles.row, !flush && styles.gutter, style]}>
      <View style={styles.rule} />
      <View style={styles.titles}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button" style={styles.actionHit}>
          {({ pressed }) => (
            <View style={[styles.action, pressed && { opacity: 0.6 }]}>
              <Text style={styles.actionLabel}>{action.label}</Text>
              <Feather name="arrow-right" size={13} color={colors.primary} />
            </View>
          )}
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  gutter: {
    paddingHorizontal: spacing.lg,
  },
  rule: {
    width: borderWidth.rule,
    backgroundColor: colors.primary,
    marginRight: spacing.md,
  },
  titles: {
    flex: 1,
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  eyebrow: {
    ...fonts.caption.sm,
    color: colors.primary,
    marginBottom: 2,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  subtitle: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: 2,
  },
  actionHit: {
    justifyContent: 'center',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionLabel: {
    ...fonts.caption.sm,
    color: colors.primary,
    marginRight: spacing.xs,
  },
})
