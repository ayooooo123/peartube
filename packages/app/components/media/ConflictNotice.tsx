import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

function asArray(value: unknown): Array<any> {
  return Array.isArray(value) ? value : []
}

function conflictLabel(conflict: any, index: number): string {
  const field = typeof conflict?.field === 'string' ? conflict.field : typeof conflict?.claimType === 'string' ? conflict.claimType : null
  const reason = typeof conflict?.reason === 'string' ? conflict.reason : typeof conflict?.message === 'string' ? conflict.message : null
  if (field && reason) return `${field}: ${reason}`
  if (field) return `${field} claim conflict`
  if (reason) return reason
  return `Metadata claim conflict ${index + 1}`
}

export interface ConflictNoticeProps {
  item: MediaCockpitItem & Record<string, any>
}

function ConflictNoticeComponent({ item }: ConflictNoticeProps) {
  const conflicts = asArray(item?.conflicts)
  if (conflicts.length === 0) return null

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.iconWrap}>
          <Ionicons name="warning" color="#fde68a" size={18} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.kicker}>Conflict notice</Text>
          <Text style={styles.title}>{conflicts.length} unresolved metadata claim{conflicts.length === 1 ? '' : 's'}</Text>
        </View>
      </View>
      <View style={styles.list}>
        {conflicts.slice(0, 4).map((conflict, index) => (
          <View key={conflict?.claimId || conflict?.id || index} style={styles.row}>
            <Text style={styles.bullet}>!</Text>
            <Text style={styles.rowText}>{conflictLabel(conflict, index)}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

export const ConflictNotice = memo(ConflictNoticeComponent)

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.30)',
    backgroundColor: 'rgba(251,191,36,0.08)',
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.34)',
    backgroundColor: 'rgba(251,191,36,0.10)',
  },
  copy: {
    flex: 1,
  },
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
  list: {
    gap: 8,
    marginTop: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  bullet: {
    color: '#fde68a',
    fontWeight: '900',
    lineHeight: 18,
  },
  rowText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
})
