import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
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
  if (status) return status
  return 'No archive evidence yet'
}

function archiveTone(status: string | null): 'good' | 'warn' | 'muted' {
  if (status === 'local' || status === 'complete-local' || status === 'cached' || status === 'retained' || status === 'archived') return 'good'
  if (status === 'partial' || status === 'pledged') return 'warn'
  return 'muted'
}

export interface ArchiveStatusProps {
  item: MediaCockpitItem & Record<string, any>
}

function ArchiveStatusComponent({ item }: ArchiveStatusProps) {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const status = pickString(item?.archiveStatus, item?.availabilityStatus, selectedSource?.archiveStatus, selectedSource?.availabilityStatus)
  const tone = archiveTone(status)
  const sourceCount = typeof item?.sourceCount === 'number' ? item.sourceCount : Array.isArray(item?.sources) ? item.sources.length : 0

  return (
    <View style={[styles.card, tone === 'good' ? styles.cardGood : tone === 'warn' ? styles.cardWarn : null]}>
      <View style={styles.headerRow}>
        <View style={[styles.iconWrap, tone === 'good' ? styles.iconGood : tone === 'warn' ? styles.iconWarn : styles.iconMuted]}>
          <Ionicons name={tone === 'good' ? 'shield-checkmark' : tone === 'warn' ? 'alert-circle' : 'cloud-offline'} color={tone === 'good' ? colors.primary : tone === 'warn' ? '#fde68a' : colors.textMuted} size={17} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.kicker}>Archive status</Text>
          <Text style={styles.title}>{archiveLabel(status)}</Text>
        </View>
      </View>
      <Text style={styles.detail}>
        {sourceCount > 0 ? `${sourceCount} source${sourceCount === 1 ? '' : 's'} known for this entity.` : 'No source claims are attached to this entity yet.'}
      </Text>
    </View>
  )
}

export const ArchiveStatus = memo(ArchiveStatusComponent)

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  cardGood: {
    borderColor: 'rgba(163,230,53,0.32)',
    backgroundColor: 'rgba(163,230,53,0.08)',
  },
  cardWarn: {
    borderColor: 'rgba(251,191,36,0.30)',
    backgroundColor: 'rgba(251,191,36,0.08)',
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
  },
  iconGood: {
    borderColor: 'rgba(163,230,53,0.36)',
    backgroundColor: 'rgba(163,230,53,0.10)',
  },
  iconWarn: {
    borderColor: 'rgba(251,191,36,0.34)',
    backgroundColor: 'rgba(251,191,36,0.10)',
  },
  iconMuted: {
    borderColor: colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  copy: {
    flex: 1,
  },
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
  detail: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
})
