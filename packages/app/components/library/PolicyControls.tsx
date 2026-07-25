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
import { colors } from '@/lib/colors'
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
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>LOCAL DEVICE POLICY</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {saving ? <ActivityIndicator color={colors.primary} /> : <View style={styles.headerSpacer} />}
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
              <Pressable onPress={onRetry} accessibilityRole="button" style={styles.actionButton}>
                <Text style={styles.actionText}>Retry</Text>
              </Pressable>
            </PolicyCard>
          ) : null}
          {children}
        </ScrollView>
      )}
    </View>
  )
}

export function PolicyCard({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warning' | 'privacy' }) {
  return <View style={[styles.card, tone === 'warning' && styles.warningCard, tone === 'privacy' && styles.privacyCard]}>{children}</View>
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
      <Text style={styles.controlLabel}>{label}</Text>
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
        <Text style={styles.controlLabel}>{label}</Text>
        <Text style={styles.body}>{detail}</Text>
        <Text style={styles.valueText}>{value === 0 ? zeroLabel : `${(value / GIB).toFixed(2).replace(/\.00$/, '')} GiB`}</Text>
      </View>
      <View style={styles.limitInputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!disabled}
          keyboardType="decimal-pad"
          inputMode="decimal"
          accessibilityLabel={`${label} in GiB`}
          style={styles.input}
          placeholder="0"
          placeholderTextColor={colors.textMuted}
        />
        <Pressable onPress={apply} disabled={disabled} accessibilityRole="button" style={[styles.actionButton, disabled && styles.disabled]}>
          <Text style={styles.actionText}>Apply</Text>
        </Pressable>
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
      <Text style={styles.controlLabel}>{label}</Text>
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
          style={[styles.input, styles.listInput]}
        />
        <Pressable onPress={add} disabled={disabled} accessibilityRole="button" style={[styles.actionButton, disabled && styles.disabled]}>
          <Text style={styles.actionText}>Add</Text>
        </Pressable>
      </View>
      {validation ? <Text style={styles.validation}>{validation}</Text> : null}
      {values.length === 0 ? <Text style={styles.empty}>None configured on this device.</Text> : (
        <View style={styles.list}>
          {values.map((value) => (
            <View key={value} style={styles.listRow}>
              <Text selectable numberOfLines={2} style={styles.mono}>{value}</Text>
              <Pressable
                onPress={() => onChange(values.filter((candidate) => candidate !== value))}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${value}`}
                style={styles.removeButton}
              >
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  backButton: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  backText: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 13 },
  headerCopy: { flex: 1, gap: 4 },
  headerSpacer: { width: 20 },
  eyebrow: { color: colors.primary, fontFamily: fonts.heading, fontSize: 10, letterSpacing: 1.1 },
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: 26, lineHeight: 31 },
  subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, maxWidth: 720 },
  content: { padding: 18, paddingBottom: 80, gap: 14, width: '100%', maxWidth: 920, alignSelf: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: colors.textMuted },
  card: { borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 18, gap: 16 },
  warningCard: { borderColor: 'rgba(245, 190, 65, 0.42)', backgroundColor: 'rgba(80, 59, 8, 0.25)' },
  privacyCard: { borderColor: 'rgba(120, 210, 255, 0.28)', backgroundColor: 'rgba(12, 35, 53, 0.38)' },
  sectionHeading: { gap: 5 },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 17, lineHeight: 22 },
  body: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  controlGroup: { gap: 10 },
  controlLabel: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 14 },
  choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexGrow: 1, flexBasis: 180, minHeight: 74, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated, padding: 12, gap: 4 },
  choiceSelected: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  choiceLabel: { color: colors.textSecondary, fontFamily: fonts.headingMedium, fontSize: 13 },
  choiceLabelSelected: { color: colors.primary },
  choiceDetail: { color: colors.textMuted, fontSize: 11, lineHeight: 15 },
  disabled: { opacity: 0.45 },
  limitRow: { gap: 10, paddingTop: 4 },
  limitCopy: { gap: 4 },
  valueText: { color: colors.primary, fontFamily: fonts.headingMedium, fontSize: 12 },
  limitInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  listInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { minWidth: 90, height: 42, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, color: colors.text, fontSize: 14 },
  listInput: { flex: 1 },
  actionButton: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', paddingHorizontal: 15, borderRadius: 11, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primaryLight },
  actionText: { color: colors.primary, fontFamily: fonts.headingMedium, fontSize: 13 },
  validation: { color: colors.warning, fontSize: 12 },
  empty: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
  list: { gap: 7 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 11, backgroundColor: colors.bgElevated },
  mono: { flex: 1, color: colors.textSecondary, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  removeButton: { paddingHorizontal: 10, paddingVertical: 7 },
  removeText: { color: colors.error, fontFamily: fonts.headingMedium, fontSize: 12 },
})
