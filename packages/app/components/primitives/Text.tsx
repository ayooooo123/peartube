import { StyleSheet, Text, TextProps } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

type Tone = 'default' | 'secondary' | 'muted' | 'accent' | 'swarm' | 'danger' | 'success' | 'warning'

const TONES: Record<Tone, string> = {
  default: colors.text,
  secondary: colors.textSecondary,
  muted: colors.textMuted,
  accent: colors.primary,
  swarm: colors.swarm,
  danger: colors.error,
  success: colors.success,
  warning: colors.warning,
}

interface ToneProps extends TextProps {
  tone?: Tone
}

/** Uppercase Syne ExtraBold screen/hero title. */
export function Display({ tone = 'default', size = 'lg', style, ...rest }: ToneProps & { size?: 'xl' | 'lg' }) {
  return <Text {...rest} style={[fonts.title[size], { color: TONES[tone] }, style]} />
}

/** Syne Bold heading for card titles and panel headers. */
export function Heading({ tone = 'default', style, ...rest }: ToneProps) {
  return <Text {...rest} style={[fonts.title.md, { color: TONES[tone] }, style]} />
}

/** Mono uppercase kicker: section labels, badges, tab labels. */
export function Eyebrow({ tone = 'muted', style, ...rest }: ToneProps) {
  return <Text {...rest} style={[fonts.caption.sm, { color: TONES[tone] }, style]} />
}

/** Mono value: durations, counts, sizes, timestamps, keys. */
export function Meta({ tone = 'secondary', size = 'sm', style, ...rest }: ToneProps & { size?: 'md' | 'sm' | 'xs' }) {
  return <Text {...rest} style={[fonts.meta[size], { color: TONES[tone] }, style]} />
}

/** System-font body copy. */
export function Body({ tone = 'secondary', size = 'md', style, ...rest }: ToneProps & { size?: 'lg' | 'md' | 'sm' }) {
  return <Text {...rest} style={[fonts.body[size], { color: TONES[tone] }, style]} />
}

export const textStyles = StyleSheet.create({
  display: { ...fonts.title.lg, color: colors.text },
  heading: { ...fonts.title.md, color: colors.text },
  eyebrow: { ...fonts.caption.sm, color: colors.textMuted },
  meta: { ...fonts.meta.sm, color: colors.textSecondary },
  body: { ...fonts.body.md, color: colors.textSecondary },
})
