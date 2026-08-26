import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

type ArchiveItem = MediaCockpitItem & {
  selectedSource?: Record<string, unknown> | null
  item?: { selectedSource?: Record<string, unknown> | null } | null
  sources?: unknown[] | null
}

export interface ArchiveStatusProps {
  status?: { pledgeCount?: number | null } | null
  item?: ArchiveItem | null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function archiveLabel(status: string | null): string {
  if (status === 'local' || status === 'complete-local') return 'Local copy complete'
  if (status === 'cached' || status === 'retained') return 'Retained nearby'
  if (status === 'pledged') return 'Archive pledged'
  if (status === 'archived') return 'Archive evidence available'
  if (status === 'partial') return 'Partial source available'
  if (status === 'missing' || status === 'unavailable') return 'Source currently missing'
  return status || 'No archive evidence yet'
}

export function ArchiveStatus({ status = null, item = null }: ArchiveStatusProps) {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const archiveState = pickString(
    item?.archiveStatus,
    item?.availabilityStatus,
    selectedSource?.archiveStatus,
    selectedSource?.availabilityStatus,
  )
  const rawPledgeCount = status?.pledgeCount
  const pledgeCount = Number.isSafeInteger(rawPledgeCount) && Number(rawPledgeCount) > 0
    ? Math.min(Number(rawPledgeCount), 1_000_000)
    : 0
  const sourceCount = typeof item?.sourceCount === 'number'
    ? item.sourceCount
    : Array.isArray(item?.sources)
      ? item.sources.length
      : 0
  const positive = archiveState === 'local' || archiveState === 'complete-local' || archiveState === 'cached' || archiveState === 'retained' || archiveState === 'archived'
  const warning = archiveState === 'partial' || archiveState === 'pledged' || pledgeCount > 0
  const detail = status
    ? pledgeCount > 0
      ? `${pledgeCount} archival pledge${pledgeCount === 1 ? '' : 's'} observed; retention is not guaranteed and may change.`
      : 'Archive state is uncertain; retention is not guaranteed.'
    : sourceCount > 0
      ? `${sourceCount} source${sourceCount === 1 ? '' : 's'} known for this entity; retention is not guaranteed.`
      : 'No source claims are attached to this entity; retention is not guaranteed.'

  return (
    <View style={[styles.card, positive ? styles.cardPositive : warning ? styles.cardWarning : null]}>
      <View style={styles.header}>
        <View style={[styles.icon, positive ? styles.iconPositive : warning ? styles.iconWarning : null]}>
          <Ionicons
            name={positive ? 'shield-checkmark' : warning ? 'alert-circle' : 'cloud-offline'}
            color={positive ? colors.primary : warning ? '#fde68a' : colors.textMuted}
            size={17}
          />
        </View>
        <View style={styles.copy}>
          <Text style={styles.kicker}>Archive status</Text>
          <Text style={styles.title}>{status ? 'Archive evidence' : archiveLabel(archiveState)}</Text>
        </View>
      </View>
      <Text style={styles.detail}>{detail}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  cardPositive: {
    borderColor: 'rgba(123, 91, 245,0.32)',
    backgroundColor: 'rgba(123, 91, 245,0.08)',
  },
  cardWarning: {
    borderColor: 'rgba(251,191,36,0.30)',
    backgroundColor: 'rgba(251,191,36,0.08)',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  iconPositive: {
    borderColor: 'rgba(123, 91, 245,0.36)',
    backgroundColor: 'rgba(123, 91, 245,0.10)',
  },
  iconWarning: {
    borderColor: 'rgba(251,191,36,0.34)',
    backgroundColor: 'rgba(251,191,36,0.10)',
  },
  copy: { flex: 1 },
  kicker: {
    color: colors.textMuted,
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
  detail: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 12 },
})
