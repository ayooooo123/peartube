import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'
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
            color={positive ? colors.primary : warning ? colors.warning : colors.textMuted}
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
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  cardPositive: {
    borderColor: colors.primary,
  },
  cardWarning: {
    borderColor: colors.warning,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  iconPositive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  iconWarning: {
    borderColor: colors.warning,
    backgroundColor: colors.warningLight,
  },
  copy: { flex: 1 },
  kicker: { ...fonts.caption.sm, color: colors.textMuted },
  title: { ...fonts.title.md, color: colors.text, marginTop: 2 },
  detail: { ...fonts.body.sm, color: colors.textMuted, marginTop: spacing.md },
})
