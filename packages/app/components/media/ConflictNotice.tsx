import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

type ConflictInput = {
  field?: string
  claimType?: string
  reason?: string
  message?: string
  claimId?: string
  id?: string
}

export interface ConflictNoticeProps {
  conflicts?: ConflictInput[]
  item?: (MediaCockpitItem & { conflicts?: unknown[] | null }) | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function conflictLabel(conflict: unknown, index: number): string {
  const record = asRecord(conflict)
  const field = pickString(record?.field, record?.claimType)
  const reason = pickString(record?.reason, record?.message)
  if (field && reason) return `${field}: ${reason}`
  if (field) return `${field} claim conflict`
  return reason || `Metadata claim conflict ${index + 1}`
}

function conflictKey(conflict: unknown, index: number): string {
  const record = asRecord(conflict)
  return pickString(record?.claimId, record?.id) || `conflict-${index}`
}

export function ConflictNotice({ conflicts, item = null }: ConflictNoticeProps) {
  const rows: unknown[] = conflicts ?? item?.conflicts ?? []
  if (rows.length === 0) return null

  return (
    <View
      accessible
      accessibilityLabel={`${rows.length} unresolved metadata claim${rows.length === 1 ? '' : 's'}`}
      accessibilityLiveRegion="polite"
      style={styles.card}
    >
      <View style={styles.header}>
        <View style={styles.icon}>
          <Ionicons name="warning" color="#fde68a" size={18} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.kicker}>Conflict notice</Text>
          <Text style={styles.title}>{rows.length} unresolved metadata claim{rows.length === 1 ? '' : 's'}</Text>
        </View>
      </View>
      <View style={styles.list}>
        {rows.slice(0, 4).map((conflict, index) => (
          <View key={conflictKey(conflict, index)} style={styles.row}>
            <Text style={styles.bullet}>!</Text>
            <Text style={styles.rowText}>{conflictLabel(conflict, index)}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.30)',
    backgroundColor: 'rgba(251,191,36,0.08)',
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.34)',
    backgroundColor: 'rgba(251,191,36,0.10)',
  },
  copy: { flex: 1 },
  kicker: {
    color: '#fde68a',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 16,
    marginTop: 2,
  },
  list: { gap: 8, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bullet: { color: '#fde68a', fontWeight: '900', lineHeight: 18 },
  rowText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
})
