import { useEffect, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Button, Panel, IconButton, Eyebrow, Body, Meta } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

const GIB = 1024 * 1024 * 1024

export function PolicyScreenFrame({
  title,
  subtitle,
  loading,
  saving,
  error,
  onBack,
  onRetry,
  children,
}: {
  title: string
  subtitle: string
  loading: boolean
  saving: boolean
  error: string | null
  onBack(): void
  onRetry(): void
  children: ReactNode
}) {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <IconButton icon="arrow-left" onPress={onBack} accessibilityLabel="Go back" variant="plain" size={36} />
        <View style={styles.headerTitles}>
          <Text style={styles.headerEyebrow}>LOCAL DEVICE POLICY</Text>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        </View>
        {saving ? <ActivityIndicator color={colors.primary} /> : <View style={styles.headerSpacer} />}
      </View>
      <View style={styles.subtitleBlock}>
        <Body size="sm" tone="secondary">{subtitle}</Body>
      </View>
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>Loading local policy…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {error ? (
            <PolicyCard tone="warning">
              <Text style={styles.cardTitle}>Policy action failed</Text>
              <Text selectable style={styles.body}>{error}</Text>
              <Button label="Retry" onPress={onRetry} variant="secondary" size="sm" />
            </PolicyCard>
          ) : null}
          {children}
        </ScrollView>
      )}
    </View>
  )
}

export function PolicyCard({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warning' | 'privacy' }) {
  const panelTone = tone === 'warning' ? 'danger' : tone === 'privacy' ? 'muted' : 'default'
  return (
    <Panel tone={panelTone} style={[styles.card, tone === 'warning' && styles.warningCard, tone === 'privacy' && styles.privacyCard]}>
      {children}
    </Panel>
  )
}

export function PolicyHeading({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.body}>{description}</Text>
    </View>
  )
}

export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; detail: string }>
  disabled?: boolean
  onChange(value: T): void
}) {
  return (
    <View style={styles.controlGroup}>
      <Eyebrow>{label}</Eyebrow>
      <View style={styles.choiceGrid}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              style={[styles.choice, selected && styles.choiceSelected, disabled && styles.disabled]}
            >
              <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{option.label}</Text>
              <Text style={styles.choiceDetail}>{option.detail}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export function ByteLimitEditor({
  label,
  detail,
  value,
  zeroLabel,
  disabled = false,
  onChange,
}: {
  label: string
  detail: string
  value: number
  zeroLabel: string
  disabled?: boolean
  onChange(value: number): void
}) {
  const [text, setText] = useState(String(value / GIB))
  const [validation, setValidation] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    setText(String(value / GIB))
  }, [value])

  const apply = () => {
    const gib = Number(text)
    const bytes = Math.round(gib * GIB)
    if (!Number.isFinite(gib) || gib < 0 || !Number.isSafeInteger(bytes)) {
      setValidation('Enter a non-negative size in GiB.')
      return
    }
    setValidation(null)
    onChange(bytes)
  }

  return (
    <View style={styles.limitRow}>
      <View style={styles.limitCopy}>
        <Eyebrow>{label}</Eyebrow>
        <Text style={styles.body}>{detail}</Text>
        <Meta tone="accent" size="sm">{value === 0 ? zeroLabel : `${(value / GIB).toFixed(2).replace(/\.00$/, '')} GiB`}</Meta>
      </View>
      <View style={styles.limitInputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!disabled}
          keyboardType="decimal-pad"
          inputMode="decimal"
          accessibilityLabel={`${label} in GiB`}
          style={[styles.input, focused && styles.inputFocused, disabled && styles.disabled]}
          placeholder="0"
          placeholderTextColor={colors.textMuted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <Button label="Apply" onPress={apply} disabled={disabled} variant="secondary" size="sm" />
      </View>
      {validation ? <Text style={styles.validation}>{validation}</Text> : null}
    </View>
  )
}

export function PolicyListEditor({
  label,
  description,
  values,
  placeholder,
  disabled = false,
  onChange,
}: {
  label: string
  description: string
  values: string[]
  placeholder: string
  disabled?: boolean
  onChange(values: string[]): void
}) {
  const [draft, setDraft] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)

  const add = () => {
    const value = draft.trim()
    if (!value) {
      setValidation('Enter an identifier first.')
      return
    }
    if (value.length > 512 || values.length >= 256) {
      setValidation('This local list has reached its safe limit.')
      return
    }
    if (values.includes(value)) {
      setValidation('That identifier is already listed.')
      return
    }
    setValidation(null)
    setDraft('')
    onChange([...values, value])
  }

  return (
    <View style={styles.controlGroup}>
      <Eyebrow>{label}</Eyebrow>
      <Text style={styles.body}>{description}</Text>
      <View style={styles.listInputRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={`Add ${label}`}
          style={[styles.input, styles.listInput, focused && styles.inputFocused, disabled && styles.disabled]}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <Button label="Add" onPress={add} disabled={disabled} variant="secondary" size="sm" />
      </View>
      {validation ? <Text style={styles.validation}>{validation}</Text> : null}
      {values.length === 0 ? <Text style={styles.empty}>None configured on this device.</Text> : (
        <View style={styles.list}>
          {values.map((value) => (
            <View key={value} style={styles.listRow}>
              <Text selectable numberOfLines={2} style={styles.mono}>{value}</Text>
              <Button
                label="Remove"
                onPress={() => onChange(values.filter((candidate) => candidate !== value))}
                disabled={disabled}
                variant="ghost"
                size="sm"
                accessibilityLabel={`Remove ${value}`}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    minHeight: 60,
    borderBottomWidth: borderWidth.rule,
    borderBottomColor: colors.border,
    gap: spacing.sm,
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
  headerSpacer: { width: 36 },
  subtitleBlock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: 80,
    gap: spacing.md,
    width: '100%',
    maxWidth: 920,
    alignSelf: 'center',
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  muted: { ...fonts.meta.sm, color: colors.textMuted },
  card: { gap: spacing.lg },
  warningCard: {
    borderColor: colors.warning,
    backgroundColor: colors.warningLight,
  },
  privacyCard: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sectionHeading: { gap: spacing.xs },
  cardTitle: {
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  body: { ...fonts.body.sm, color: colors.textSecondary },
  controlGroup: { gap: spacing.sm },
  choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    flexGrow: 1,
    flexBasis: 180,
    minHeight: 74,
    borderRadius: radius.md,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: spacing.md,
    gap: spacing.xs,
  },
  choiceSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  choiceLabel: {
    ...fonts.label.md,
    color: colors.textSecondary,
  },
  choiceLabelSelected: {
    color: colors.primary,
  },
  choiceDetail: {
    ...fonts.meta.xs,
    color: colors.textMuted,
    lineHeight: 15,
  },
  disabled: { opacity: 0.45 },
  limitRow: { gap: spacing.sm, paddingTop: spacing.xs },
  limitCopy: { gap: spacing.xs },
  limitInputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  listInputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    minWidth: 90,
    height: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    ...fonts.meta.sm,
  },
  inputFocused: {
    borderColor: colors.borderFocus,
  },
  listInput: { flex: 1 },
  validation: { ...fonts.meta.sm, color: colors.warning },
  empty: { ...fonts.meta.sm, color: colors.textMuted },
  list: { gap: spacing.sm },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgElevated,
  },
  mono: {
    flex: 1,
    ...fonts.meta.xs,
    color: colors.textSecondary,
  },
})
