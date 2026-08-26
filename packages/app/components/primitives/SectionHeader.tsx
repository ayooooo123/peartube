import { Pressable, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

interface SectionHeaderProps {
  title: string
  subtitle?: string
  action?: { label: string; onPress: () => void }
  style?: StyleProp<ViewStyle>
}

export function SectionHeader({ title, subtitle, action, style }: SectionHeaderProps) {
  return (
    <View style={[styles.row, style]}>
      <View style={styles.titles}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
          {({ pressed }) => (
            <Text style={[styles.action, pressed && { opacity: 0.6 }]}>{action.label}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 24,
    marginBottom: 12,
  },
  titles: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    fontFamily: fonts.heading,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  action: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
})
