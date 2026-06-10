/**
 * ReactionButton - Like button with a long-press reaction picker.
 *
 * Tap toggles a plain like; long-press opens an animated picker with the
 * full reaction set (the backend already supports arbitrary reaction types).
 */
import { memo, useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated'
import { colors } from '@/lib/colors'
import { styles as playerStyles } from './styles'
import * as haptics from '@/lib/haptics'

export const REACTIONS: Array<{ type: string; emoji: string; label: string }> = [
  { type: 'like', emoji: '👍', label: 'Like' },
  { type: 'love', emoji: '❤️', label: 'Love' },
  { type: 'laugh', emoji: '😂', label: 'Funny' },
  { type: 'fire', emoji: '🔥', label: 'Fire' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
]

interface ReactionButtonProps {
  reactionCounts: Record<string, number>
  userReaction: string | null
  onToggleReaction: (type: string) => void
}

export const ReactionButton = memo(function ReactionButton({
  reactionCounts,
  userReaction,
  onToggleReaction,
}: ReactionButtonProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const current = REACTIONS.find((r) => r.type === userReaction) || null
  const totalCount = REACTIONS.reduce((sum, r) => sum + (reactionCounts[r.type] || 0), 0)

  const handlePress = useCallback(() => {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    haptics.reaction()
    onToggleReaction(current ? current.type : 'like')
  }, [pickerOpen, current, onToggleReaction])

  const handleLongPress = useCallback(() => {
    haptics.reaction()
    setPickerOpen(true)
  }, [])

  const handlePick = useCallback((type: string) => {
    haptics.reaction()
    setPickerOpen(false)
    onToggleReaction(type)
  }, [onToggleReaction])

  return (
    <View style={styles.wrapper}>
      {pickerOpen && (
        <Animated.View
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(120)}
          style={styles.picker}
        >
          {REACTIONS.map((r, idx) => {
            const count = reactionCounts[r.type] || 0
            const selected = userReaction === r.type
            return (
              <Animated.View key={r.type} entering={ZoomIn.delay(idx * 35).duration(160)}>
                <Pressable
                  onPress={() => handlePick(r.type)}
                  accessibilityRole="button"
                  accessibilityLabel={r.label}
                  style={({ pressed }) => [
                    styles.pickerItem,
                    selected && styles.pickerItemSelected,
                    pressed && { transform: [{ scale: 1.2 }] },
                  ]}
                >
                  <Text style={styles.pickerEmoji}>{r.emoji}</Text>
                  {count > 0 && <Text style={styles.pickerCount}>{count}</Text>}
                </Pressable>
              </Animated.View>
            )
          })}
        </Animated.View>
      )}

      <Pressable
        style={playerStyles.actionButton}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityLabel={current ? `Reacted ${current.label}. Long press for more reactions` : 'Like. Long press for more reactions'}
        accessibilityState={{ selected: Boolean(current) }}
      >
        {current && current.type !== 'like' ? (
          <Text style={{ fontSize: 21 }}>{current.emoji}</Text>
        ) : (
          <Feather name="thumbs-up" color={current ? colors.primary : colors.text} size={22} />
        )}
        <Text
          numberOfLines={1}
          style={[playerStyles.actionLabel, current && playerStyles.actionLabelActive]}
        >
          {current && current.type !== 'like' ? current.label : 'Like'}{totalCount > 0 ? ` (${totalCount})` : ''}
        </Text>
      </Pressable>
    </View>
  )
})

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
  },
  picker: {
    position: 'absolute',
    bottom: '100%',
    left: -8,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(20, 24, 20, 0.97)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 24,
    paddingHorizontal: 8,
    paddingVertical: 6,
    zIndex: 50,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
  },
  pickerItem: {
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 16,
  },
  pickerItemSelected: {
    backgroundColor: colors.primaryLight,
  },
  pickerEmoji: {
    fontSize: 24,
  },
  pickerCount: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 1,
  },
})
