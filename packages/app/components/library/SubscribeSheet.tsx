import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { GlassCard } from '@/components/primitives'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import * as haptics from '@/lib/haptics'

const isValidChannelKey = (key: string) => /^[a-f0-9]{64}$/i.test(key)

interface ChannelPreview {
  name?: string
  description?: string
  videoCount?: number
}

interface SubscribeSheetProps {
  rpc: any
  onSubscribed: () => void
}

/**
 * Paste-a-key subscribe flow with a channel preview step:
 * the key is looked up via getChannelMeta and shown as a card
 * before the user confirms the subscription.
 */
export function SubscribeSheet({ rpc, onSubscribed }: SubscribeSheetProps) {
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<'input' | 'previewing' | 'preview' | 'subscribing'>('input')
  const [preview, setPreview] = useState<ChannelPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const trimmed = key.trim()
  const valid = isValidChannelKey(trimmed)

  const lookUp = useCallback(async () => {
    if (!rpc || !valid) return
    setError(null)
    setPhase('previewing')
    try {
      const meta = await Promise.race([
        rpc.getChannelMeta({ channelKey: trimmed }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]) as ChannelPreview
      setPreview(meta || {})
      setPhase('preview')
    } catch {
      // Channel not reachable yet — still allow subscribing blind.
      setPreview(null)
      setPhase('preview')
    }
  }, [rpc, trimmed, valid])

  const subscribe = useCallback(async () => {
    if (!rpc) return
    setError(null)
    setPhase('subscribing')
    try {
      await rpc.subscribeChannel({ channelKey: trimmed })
      haptics.success()
      setKey('')
      setPreview(null)
      setPhase('input')
      onSubscribed()
    } catch (err: any) {
      setError(err?.message || 'Failed to subscribe')
      setPhase('preview')
    }
  }, [rpc, trimmed, onSubscribed])

  const reset = useCallback(() => {
    setPreview(null)
    setError(null)
    setPhase('input')
  }, [])

  return (
    <View style={styles.container}>
      {(phase === 'input' || phase === 'previewing') && (
        <View style={styles.inputRow}>
          <View style={styles.inputShell}>
            <Feather name="link" size={15} color={colors.textMuted} />
            <TextInput
              placeholder="Paste a channel key"
              value={key}
              onChangeText={setKey}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              editable={phase === 'input'}
              onSubmitEditing={lookUp}
            />
          </View>
          <Pressable
            onPress={lookUp}
            disabled={!valid || phase === 'previewing'}
            style={({ pressed }) => [
              styles.lookupButton,
              (!valid || phase === 'previewing') && { opacity: 0.4 },
              pressed && { opacity: 0.8 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Find channel"
          >
            {phase === 'previewing' ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Feather name="arrow-right" size={17} color={colors.onPrimary} />
            )}
          </Pressable>
        </View>
      )}
      {phase === 'input' && trimmed.length > 0 && !valid && (
        <Text style={styles.hint}>A channel key is 64 hex characters</Text>
      )}

      {(phase === 'preview' || phase === 'subscribing') && (
        <GlassCard highlight style={styles.previewCard}>
          <View style={styles.previewRow}>
            <View style={styles.previewAvatar}>
              <Text style={styles.previewLetter}>
                {(preview?.name || '?').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.previewName} numberOfLines={1}>
                {preview?.name || 'Channel not reachable yet'}
              </Text>
              <Text style={styles.previewMeta} numberOfLines={2}>
                {preview?.name
                  ? `${preview?.videoCount ?? 0} video${(preview?.videoCount ?? 0) === 1 ? '' : 's'}${preview?.description ? ` · ${preview.description}` : ''}`
                  : 'You can still subscribe — it will sync when peers appear.'}
              </Text>
            </View>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.previewActions}>
            <Pressable onPress={reset} style={({ pressed }) => [styles.secondaryButton, pressed && { opacity: 0.7 }]}>
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={subscribe}
              disabled={phase === 'subscribing'}
              style={({ pressed }) => [styles.primaryButton, pressed && { opacity: 0.8 }]}
            >
              {phase === 'subscribing' ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <>
                  <Feather name="user-plus" size={15} color={colors.onPrimary} />
                  <Text style={styles.primaryLabel}>Subscribe</Text>
                </>
              )}
            </Pressable>
          </View>
        </GlassCard>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputShell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 22,
    paddingHorizontal: 14,
    height: 44,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    marginLeft: 8,
  },
  lookupButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 6,
    marginLeft: 14,
  },
  previewCard: {
    marginTop: 4,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  previewAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgActive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewLetter: {
    color: colors.text,
    fontSize: 20,
    fontFamily: fonts.heading,
  },
  previewName: {
    color: colors.text,
    fontSize: 15,
    fontFamily: fonts.heading,
  },
  previewMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  error: {
    color: colors.error,
    fontSize: 12,
    marginTop: 10,
  },
  previewActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 14,
  },
  secondaryButton: {
    paddingHorizontal: 16,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  secondaryLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primary,
    justifyContent: 'center',
  },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
})
