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
function computePledgeCount(rawPledgeCount: unknown): number {
  if (Number.isSafeInteger(rawPledgeCount) && Number(rawPledgeCount) > 0) {
    return Math.min(Number(rawPledgeCount), 1_000_000)
  }
  return 0
}

function computeSourceCount(item?: ArchiveItem | null): number {
  if (typeof item?.sourceCount === 'number') return item.sourceCount
  if (Array.isArray(item?.sources)) return item.sources.length
  return 0
}

function isPositiveArchiveState(state: string | null): boolean {
  return (
    state === 'local' ||
    state === 'complete-local' ||
    state === 'cached' ||
    state === 'retained' ||
    state === 'archived'
  )
}

function isWarningArchiveState(state: string | null, pledgeCount: number): boolean {
  return state === 'partial' || state === 'pledged' || pledgeCount > 0
}

function formatArchiveDetail(
  hasStatus: boolean,
  pledgeCount: number,
  sourceCount: number
): string {
  if (hasStatus) {
    if (pledgeCount > 0) {
      const suffix = pledgeCount === 1 ? '' : 's'
      return `${pledgeCount} archival pledge${suffix} observed; retention is not guaranteed and may change.`
    }
    return 'Archive state is uncertain; retention is not guaranteed.'
  }
  if (sourceCount > 0) {
    const suffix = sourceCount === 1 ? '' : 's'
    return `${sourceCount} source${suffix} known for this entity; retention is not guaranteed.`
  }
  return 'No source claims are attached to this entity; retention is not guaranteed.'
}

function getArchiveTone(positive: boolean, warning: boolean) {
  if (positive) {
    return {
      cardStyle: styles.cardPositive,
      iconStyle: styles.iconPositive,
      iconName: 'shield-checkmark' as const,
      iconColor: colors.primary,
    }
  }
  if (warning) {
    return {
      cardStyle: styles.cardWarning,
      iconStyle: styles.iconWarning,
      iconName: 'alert-circle' as const,
      iconColor: '#fde68a',
    }
  }
  return {
    cardStyle: null,
    iconStyle: null,
    iconName: 'cloud-offline' as const,
    iconColor: colors.textMuted,
  }
}

export function ArchiveStatus({ status = null, item = null }: ArchiveStatusProps) {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const archiveState = pickString(
    item?.archiveStatus,
    item?.availabilityStatus,
    selectedSource?.archiveStatus,
    selectedSource?.availabilityStatus,
  )
  const pledgeCount = computePledgeCount(status?.pledgeCount)
  const sourceCount = computeSourceCount(item)
  const positive = isPositiveArchiveState(archiveState)
  const warning = isWarningArchiveState(archiveState, pledgeCount)
  const detail = formatArchiveDetail(Boolean(status), pledgeCount, sourceCount)
  const tone = getArchiveTone(positive, warning)

  return (
    <View style={[styles.card, tone.cardStyle]}>
      <View style={styles.header}>
        <View style={[styles.icon, tone.iconStyle]}>
          <Ionicons
            name={tone.iconName}
            color={tone.iconColor}
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
