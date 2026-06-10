import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { GlassCard } from '@/components/primitives'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

export interface SubscriptionItem {
  channelKey: string
  publicBeeKey?: string | null
  name: string
  subscribedAt?: number
}

interface ChannelRowProps {
  item: SubscriptionItem
  pinned: boolean
  onOpen: () => void
  onUnsubscribe: () => void
  onTogglePin: () => void
  onRetrySync: () => void
}

/**
 * Subscribed-channel row with an inline expanding action tray
 * (unsubscribe / keep-offline pin / retry sync) — works identically
 * on native and web without platform menus.
 */
export function ChannelRow({ item, pinned, onOpen, onUnsubscribe, onTogglePin, onRetrySync }: ChannelRowProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <GlassCard padded={false} style={styles.card}>
      <View style={styles.row}>
        <Pressable onPress={onOpen} style={({ pressed }) => [styles.main, pressed && { opacity: 0.7 }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarLetter}>{item.name?.charAt(0)?.toUpperCase() || '?'}</Text>
            {pinned && (
              <View style={styles.pinBadge}>
                <Feather name="anchor" size={9} color={colors.onPrimary} />
              </View>
            )}
          </View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>{item.name || 'Unknown Channel'}</Text>
            <Text style={styles.key} numberOfLines={1}>
              {pinned ? 'Kept online · ' : ''}{item.channelKey.substring(0, 16)}…
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Channel options"
          style={styles.moreButton}
        >
          <Feather name={expanded ? 'chevron-up' : 'more-horizontal'} size={18} color={colors.textMuted} />
        </Pressable>
      </View>

      {expanded && (
        <View style={styles.tray}>
          <TrayAction
            icon="anchor"
            label={pinned ? 'Stop keeping online' : 'Keep available offline'}
            onPress={() => { setExpanded(false); onTogglePin() }}
          />
          <TrayAction
            icon="refresh-cw"
            label="Retry sync"
            onPress={() => { setExpanded(false); onRetrySync() }}
          />
          <TrayAction
            icon="user-x"
            label="Unsubscribe"
            destructive
            onPress={() => { setExpanded(false); onUnsubscribe() }}
          />
        </View>
      )}
    </GlassCard>
  )
}

function TrayAction({
  icon,
  label,
  onPress,
  destructive = false,
}: {
  icon: keyof typeof Feather.glyphMap
  label: string
  onPress: () => void
  destructive?: boolean
}) {
  const color = destructive ? colors.error : colors.textSecondary
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.trayAction, pressed && { opacity: 0.6 }]}>
      <Feather name={icon} size={15} color={color} />
      <Text style={[styles.trayLabel, { color }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgActive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.text,
    fontSize: 18,
    fontFamily: fonts.heading,
  },
  pinBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  key: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  moreButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tray: {
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    paddingVertical: 4,
  },
  trayAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  trayLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
})
