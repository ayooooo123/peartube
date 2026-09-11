import { useCallback, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { Button, Panel } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
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
function formatPreviewMeta(preview: ChannelPreview | null): string {
  if (!preview?.name) {
    return 'You can still subscribe — it will sync when peers appear.'
  }
  const count = preview.videoCount ?? 0
  const suffix = count === 1 ? '' : 's'
  const desc = preview.description ? ` · ${preview.description}` : ''
  return `${count} video${suffix}${desc}`
}

interface ChannelPreviewCardProps {
  preview: ChannelPreview | null
  phase: 'input' | 'previewing' | 'preview' | 'subscribing'
  error: string | null
  onReset: () => void
  onSubscribe: () => void
}

function ChannelPreviewCard({ preview, phase, error, onReset, onSubscribe }: ChannelPreviewCardProps) {
  const isSubscribing = phase === 'subscribing'
  const initial = (preview?.name || '?').charAt(0).toUpperCase()
  const title = preview?.name || 'Channel not reachable yet'
  const metaText = formatPreviewMeta(preview)

  return (
    <Panel tone="accent" style={styles.previewCard}>
      <View style={styles.previewRow}>
        <View style={styles.previewAvatar}>
          <Text style={styles.previewLetter}>{initial}</Text>
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text style={styles.previewName} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.previewMeta} numberOfLines={2}>
            {metaText}
          </Text>
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.previewActions}>
        <Button label="Cancel" onPress={onReset} variant="ghost" size="sm" />
        <Button
          label="Subscribe"
          onPress={onSubscribe}
          disabled={isSubscribing}
          loading={isSubscribing}
          icon="user-plus"
          size="sm"
        />
      </View>
    </Panel>
  )
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
  const [focused, setFocused] = useState(false)

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
          <View style={[styles.inputShell, focused && styles.inputShellFocused]}>
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
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </View>
          <Button
            label={phase === 'previewing' ? '…' : 'Find'}
            onPress={lookUp}
            disabled={!valid || phase === 'previewing'}
            loading={phase === 'previewing'}
            size="md"
            accessibilityLabel="Find channel"
            style={styles.lookupButton}
          />
        </View>
      )}
      {phase === 'input' && trimmed.length > 0 && !valid && (
        <Text style={styles.hint}>A channel key is 64 hex characters</Text>
      )}

      {(phase === 'preview' || phase === 'subscribing') && (
        <ChannelPreviewCard
          preview={preview}
          phase={phase}
          error={error}
          onReset={reset}
          onSubscribe={subscribe}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    marginBottom: spacing.md,
    borderTopWidth: borderWidth.rule,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  inputShell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  inputShellFocused: {
    borderColor: colors.borderFocus,
  },
  input: {
    flex: 1,
    color: colors.text,
    ...fonts.meta.sm,
    marginLeft: spacing.sm,
  },
  lookupButton: {
    minWidth: 72,
  },
  hint: {
    ...fonts.meta.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginLeft: spacing.sm,
  },
  previewCard: {
    marginTop: spacing.sm,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  previewAvatar: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewLetter: {
    color: colors.text,
    fontSize: 20,
    fontFamily: fonts.heading,
  },
  previewName: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  previewMeta: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: 3,
  },
  error: {
    ...fonts.meta.sm,
    color: colors.error,
    marginTop: spacing.md,
  },
  previewActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
})
