import { StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Button } from './Button'

interface EmptyStateProps {
  icon: keyof typeof Feather.glyphMap
  title: string
  body?: string
  /** Mono status line above the title, e.g. `0 PEERS · DHT OK`. */
  status?: string
  action?: { label: string; onPress: () => void }
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * Empty list placeholder: bordered square glyph, uppercase Syne title,
 * system-font body, optional mono status line and a secondary action.
 */
export function EmptyState({ icon, title, body, status, action, style, testID }: EmptyStateProps) {
  return (
    <View style={[styles.container, style]} testID={testID}>
      <View style={styles.iconShell}>
        <Feather name={icon} size={24} color={colors.textSecondary} />
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action ? (
        <Button label={action.label} onPress={action.onPress} variant="secondary" size="sm" style={styles.button} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl + spacing.sm,
    paddingHorizontal: spacing.xxl,
  },
  iconShell: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  status: {
    ...fonts.caption.sm,
    color: colors.primary,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  title: {
    ...fonts.title.lg,
    fontSize: 20,
    lineHeight: 24,
    color: colors.text,
    textAlign: 'center',
  },
  body: {
    ...fonts.body.sm,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    maxWidth: 300,
  },
  button: {
    marginTop: spacing.xl,
  },
})
