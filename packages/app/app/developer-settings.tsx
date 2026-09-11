import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DeveloperModeGate, useDeveloperMode } from '@/lib/developer-mode'
import { NativeSwitch } from '@/components/native-ui'
import { Button, Divider, Panel, ScreenHeader, SectionHeader } from '@/components/primitives'
import { ArchiveParticipationControl } from '@/components/developer/ArchiveParticipationControl'
import { ModerationFeedEditor } from '@/components/library/ModerationFeedEditor'
import { colors, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import {
  createModerationProfileActions,
  type ModerationProfileRpc,
  type ModerationProfileState,
} from '@/lib/moderation-profile'
import { useApp } from './_layout'

type FeatherIconName = keyof typeof Feather.glyphMap

type DeveloperRoute = {
  label: string
  detail: string
  icon: FeatherIconName
  path: Href
}

const developerRoutes: readonly DeveloperRoute[] = [
  { label: 'Studio', detail: 'Upload and manage publications.', icon: 'video', path: '/studio' },
  { label: 'Publishing security', detail: 'Review publisher writer capability and signer status.', icon: 'lock', path: '/publisher-security' },
  { label: 'Network policy', detail: 'Configure transfer, retention, and local network behavior.', icon: 'sliders', path: '/network-policy' },
  { label: 'Acquisition policy', detail: 'Set consent, admission, budgets, retention, and retry limits.', icon: 'download-cloud', path: '/acquisition-settings' },
  { label: 'Archive & maintenance', detail: 'Migration, backups, reports, import, and export.', icon: 'archive', path: '/maintenance' },
  { label: 'Feed trust', detail: 'Choose publisher catalogs and signed indexes to follow.', icon: 'rss', path: '/subscriptions' },
  { label: 'Moderation administration', detail: 'Manage local moderation feeds and analysis.', icon: 'shield', path: '/moderation' },
  { label: 'Identity tools', detail: 'Manage the local channel and linked devices.', icon: 'key', path: '/profile?developer=identity' },
  { label: 'Diagnostics', detail: 'Inspect local swarm, seeding, and storage state.', icon: 'activity', path: '/profile?developer=diagnostics' },
]

function toModerationProfileRpc(rpc: unknown): ModerationProfileRpc | null {
  if (!rpc || typeof rpc !== 'object') return null
  const candidate = rpc as Record<string, unknown>
  const getPersonalSettings = candidate.getPersonalSettings
  const setPersonalSetting = candidate.setPersonalSetting
  return {
    getPersonalSettings: typeof getPersonalSettings === 'function'
      ? (getPersonalSettings as NonNullable<ModerationProfileRpc['getPersonalSettings']>).bind(rpc)
      : undefined,
    setPersonalSetting: typeof setPersonalSetting === 'function'
      ? (setPersonalSetting as NonNullable<ModerationProfileRpc['setPersonalSetting']>).bind(rpc)
      : undefined,
  }
}

function DeveloperSettingsContent() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const developerMode = useDeveloperMode()
  const { enabled, isLoading } = developerMode
  const { rpc } = useApp()
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null)
  const moderationProfileActions = useMemo(
    () => createModerationProfileActions(toModerationProfileRpc(rpc)),
    [rpc],
  )
  const [moderationProfile, setModerationProfile] = useState<ModerationProfileState | null>(null)
  const [moderationProfileError, setModerationProfileError] = useState<string | null>(null)

  const refreshModerationProfile = async () => {
    try {
      setModerationProfile(await moderationProfileActions.load())
      setModerationProfileError(null)
    } catch {
      setModerationProfileError('Unable to read the local moderation profile.')
    }
  }

  useEffect(() => { void refreshModerationProfile() }, [])

  const handleDeveloperModeChange = async (enabled: boolean) => {
    setDeveloperModeError(null)
    try {
      await developerMode.setEnabled(enabled)
    } catch {
      setDeveloperModeError('Unable to update Developer Mode locally. Please try again.')
    }
  }

  return (
    <View style={styles.screen}>
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Developer Settings" eyebrow="OPERATOR / LOCAL" onBack={() => router.back()} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <SectionHeader title="Developer Mode" subtitle="Local to this device. It is not synchronized and does not grant publishing permission." />
        <Panel style={styles.card}>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Enable Developer Mode</Text>
              <Text style={styles.rowDetail}>Show operator and publishing controls on this device.</Text>
            </View>
            <NativeSwitch
              value={enabled}
              disabled={isLoading}
              onValueChange={(value: boolean) => { void handleDeveloperModeChange(value) }}
              trackColor={{ false: colors.bgActive, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
          {developerModeError ? <Text accessibilityRole="alert" style={styles.error}>{developerModeError}</Text> : null}
        </Panel>

        {enabled ? (
          <DeveloperModeGate>
            <SectionHeader title="Default moderation profile" subtitle="Versioned, local-only subscriptions. Curator keys authenticate their own optional feeds; they do not authorize publishers or media." />
            <Panel tone="muted" style={styles.card}>
              <Text style={styles.rowTitle}>Active moderation profile</Text>
              <Text style={styles.monoFact}>Version: {moderationProfile?.profile.version ?? 'unavailable'}</Text>
              <Text style={styles.monoFact}>Enabled: {moderationProfile ? (moderationProfile.profile.enabled ? 'yes' : 'no') : 'unavailable'}</Text>
              <Text style={styles.monoFact}>Customized: {moderationProfile ? (moderationProfile.customized ? 'yes' : 'no') : 'unavailable'}</Text>
              <Text style={styles.profileLabel}>Subscription signer IDs</Text>
              {moderationProfile?.profile.curatorSubscriptions.length === 0 ? (
                <Text style={styles.rowDetail}>None configured on this device.</Text>
              ) : null}
              {(moderationProfile?.profile.curatorSubscriptions ?? []).map((signerId) => (
                <Text
                  key={signerId}
                  selectable
                  numberOfLines={2}
                  accessibilityLabel={`Moderation subscription signer ${signerId}`}
                  style={styles.signerId}
                >
                  {signerId}
                </Text>
              ))}
              <View style={styles.profileActions}>
                <Button
                  label="Disable"
                  size="sm"
                  variant="secondary"
                  disabled={!moderationProfile}
                  onPress={() => {
                    if (moderationProfile) {
                      void moderationProfileActions.disable(moderationProfile).then(setModerationProfile).catch(() => setModerationProfileError('Unable to update the local moderation profile.'))
                    }
                  }}
                />
                <Button
                  label="Restore Defaults"
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    void moderationProfileActions.restoreDefaults().then(setModerationProfile).catch(() => setModerationProfileError('Unable to restore the local moderation profile.'))
                  }}
                />
                <Button
                  label="Clear Curators"
                  size="sm"
                  variant="secondary"
                  disabled={!moderationProfile}
                  onPress={() => {
                    if (moderationProfile) {
                      void moderationProfileActions.replace(moderationProfile, []).then(setModerationProfile).catch(() => setModerationProfileError('Unable to replace the local moderation profile.'))
                    }
                  }}
                />
              </View>
              {moderationProfileError ? <Text accessibilityRole="alert" style={styles.error}>{moderationProfileError}</Text> : null}
            </Panel>
            {moderationProfile ? (
              <View style={styles.profileEditor}>
                <ModerationFeedEditor
                  subscriptions={moderationProfile.profile.curatorSubscriptions}
                  onReplace={(subscriptions) => {
                    void moderationProfileActions.replace(moderationProfile, subscriptions)
                      .then(setModerationProfile)
                      .catch(() => setModerationProfileError('Unable to replace the local moderation profile.'))
                  }}
                />
              </View>
            ) : null}
            <SectionHeader title="Archive participation" subtitle="Volunteer storage is an operator-controlled local network setting." />
            <Panel padded={false} style={styles.card}>
              <ArchiveParticipationControl rpc={rpc} />
            </Panel>
            <SectionHeader title="Operator tools" subtitle="These screens remain subject to their existing signer, writer-capability, and backend admission checks." />
            <Panel padded={false} style={styles.card}>
              {developerRoutes.map((route, index) => (
                <View key={String(route.path)}>
                  {index > 0 ? <Divider weight="hairline" /> : null}
                  <Pressable
                    onPress={() => router.push(route.path)}
                    style={styles.route}
                    accessibilityRole="button"
                  >
                    <Feather name={route.icon} size={16} color={colors.textMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{route.label}</Text>
                      <Text style={styles.rowDetail}>{route.detail}</Text>
                    </View>
                    <Feather name="chevron-right" size={17} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </Panel>
          </DeveloperModeGate>
        ) : (
          <Text style={styles.disabledCopy}>Enable Developer Mode from Profile to reveal these local tools. Disabling it closes any open privileged screen without changing playback or publisher state.</Text>
        )}
      </ScrollView>
    </View>
  )
}

export default function DeveloperSettingsScreen() {
  return <DeveloperSettingsContent />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: spacing.xxxl },
  card: { marginHorizontal: spacing.lg },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52 },
  error: { color: colors.error, ...fonts.meta.sm, lineHeight: 17, marginTop: spacing.sm },
  route: { minHeight: 64, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { color: colors.text, ...fonts.title.md, fontSize: 14, lineHeight: 18 },
  rowDetail: { color: colors.textMuted, ...fonts.body.sm, fontSize: 12, lineHeight: 17, marginTop: 2 },
  monoFact: { color: colors.textSecondary, ...fonts.meta.sm, marginTop: 2 },
  profileLabel: { color: colors.text, ...fonts.caption.sm, marginTop: spacing.md },
  signerId: { color: colors.textMuted, ...fonts.meta.xs, lineHeight: 16, marginTop: spacing.xs },
  profileEditor: { marginHorizontal: spacing.lg },
  profileActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  disabledCopy: { color: colors.textMuted, ...fonts.body.sm, lineHeight: 19, marginHorizontal: spacing.xl, marginTop: spacing.sm },
})
