import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { Divider, IconButton } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
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
    <View>
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
        <IconButton
          icon={expanded ? 'chevron-up' : 'more-horizontal'}
          onPress={() => setExpanded((v) => !v)}
          accessibilityLabel="Channel options"
          variant="plain"
          size={36}
        />
      </View>

      {expanded && (
        <View style={styles.tray}>
          <Divider />
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
    </View>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
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
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.rule,
    borderColor: colors.bg,
  },
  info: {
    flex: 1,
    marginLeft: spacing.md,
  },
  name: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  key: {
    ...fonts.meta.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  tray: {
    paddingBottom: spacing.sm,
  },
  trayAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  trayLabel: {
    ...fonts.body.sm,
    fontWeight: '500',
  },
})
