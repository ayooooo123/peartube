import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { DeveloperModeGate, useDeveloperMode } from '@/lib/developer-mode'
import { NativeSwitch } from '@/components/native-ui'
import { GlassCard, SectionHeader } from '@/components/primitives'
import { ArchiveParticipationControl } from '@/components/developer/ArchiveParticipationControl'
import { colors } from '@/lib/colors'
import { createDefaultModerationProfileStore, DEFAULT_MODERATION_PROFILE, type ModerationProfile } from '@/lib/default-moderation-profile'
import { secureGet, secureSet } from '@/lib/secure-storage'
import { useApp } from './_layout'

const developerRoutes = [
  { label: 'Studio', detail: 'Upload and manage publications.', icon: 'video', path: '/studio' },
  { label: 'Publishing security', detail: 'Review publisher writer capability and signer status.', icon: 'lock', path: '/publisher-security' },
  { label: 'Network policy', detail: 'Configure transfer, retention, and local network behavior.', icon: 'sliders', path: '/network-policy' },
  { label: 'Archive & maintenance', detail: 'Migration, backups, reports, import, and export.', icon: 'archive', path: '/maintenance' },
  { label: 'Feed trust', detail: 'Choose publisher catalogs and signed indexes to follow.', icon: 'rss', path: '/subscriptions' },
  { label: 'Moderation administration', detail: 'Manage local moderation feeds and analysis.', icon: 'shield', path: '/moderation' },
  { label: 'Identity tools', detail: 'Manage the local channel and linked devices.', icon: 'key', path: '/profile?developer=identity' },
  { label: 'Diagnostics', detail: 'Inspect local swarm, seeding, and storage state.', icon: 'activity', path: '/profile?developer=diagnostics' },
] as const

function DeveloperSettingsContent() {
  const router = useRouter()
  const developerMode = useDeveloperMode()
  const { enabled, isLoading } = developerMode
  const { rpc } = useApp()
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null)
  const [moderationProfile, setModerationProfile] = useState<ModerationProfile | null>(null)
  const [moderationProfileError, setModerationProfileError] = useState<string | null>(null)
  const moderationStore = useMemo(() => createDefaultModerationProfileStore({
    storage: {
      async get(key) {
        const raw = await secureGet(key)
        try { return raw ? JSON.parse(raw) : null } catch { return null }
      },
      async set(key, value) { await secureSet(key, JSON.stringify(value)) },
    },
  }), [])

  const refreshModerationProfile = async () => {
    try {
      setModerationProfile((await moderationStore.inspect()).profile)
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
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backButton} accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Developer Settings</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Developer Mode" subtitle="Local to this device. It is not synchronized and does not grant publishing permission." />
        <GlassCard style={styles.card}>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Enable Developer Mode</Text>
              <Text style={styles.rowDetail}>Show operator and publishing controls on this device.</Text>
            </View>
            <NativeSwitch
              value={enabled}
              disabled={isLoading}
              onValueChange={(value: boolean) => { void handleDeveloperModeChange(value) }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
          {developerModeError ? <Text accessibilityRole="alert" style={styles.error}>{developerModeError}</Text> : null}
        </GlassCard>

        {enabled ? (
          <DeveloperModeGate>
            <SectionHeader title="Default moderation profile" subtitle="Versioned, local-only subscriptions. Curator keys authenticate their own optional feeds; they do not authorize publishers or media." />
            <GlassCard style={styles.card}>
              <Text style={styles.rowTitle}>Community profile v{moderationProfile?.version ?? DEFAULT_MODERATION_PROFILE.version}</Text>
              <Text style={styles.rowDetail}>{moderationProfile?.enabled === false ? 'Disabled: records remain local and can be revealed on this device.' : `${moderationProfile?.curatorSubscriptions.length ?? 0} optional curator subscriptions.`}</Text>
              <View style={styles.profileActions}>
                <Pressable onPress={() => { void moderationStore.disable().then(refreshModerationProfile).catch(() => setModerationProfileError('Unable to update the local moderation profile.')) }} style={styles.profileButton}>
                  <Text style={styles.profileButtonText}>Disable</Text>
                </Pressable>
                <Pressable onPress={() => { void moderationStore.restoreDefaults().then(refreshModerationProfile).catch(() => setModerationProfileError('Unable to restore the local moderation profile.')) }} style={styles.profileButton}>
                  <Text style={styles.profileButtonText}>Restore Defaults</Text>
                </Pressable>
                <Pressable onPress={() => { void moderationStore.replace({ ...(moderationProfile || DEFAULT_MODERATION_PROFILE), curatorSubscriptions: [] }).then(refreshModerationProfile).catch(() => setModerationProfileError('Unable to replace the local moderation profile.')) }} style={styles.profileButton}>
                  <Text style={styles.profileButtonText}>Clear Curators</Text>
                </Pressable>
              </View>
              {moderationProfileError ? <Text accessibilityRole="alert" style={styles.error}>{moderationProfileError}</Text> : null}
            </GlassCard>
            <SectionHeader title="Archive participation" subtitle="Volunteer storage is an operator-controlled local network setting." />
            <GlassCard padded={false} style={styles.card}>
              <ArchiveParticipationControl rpc={rpc} />
            </GlassCard>
            <SectionHeader title="Operator tools" subtitle="These screens remain subject to their existing signer, writer-capability, and backend admission checks." />
            <GlassCard padded={false} style={styles.card}>
              {developerRoutes.map((route, index) => (
                <Pressable
                  key={route.path}
                  onPress={() => router.push(route.path as any)}
                  style={[styles.route, index > 0 && styles.routeBorder]}
                  accessibilityRole="button"
                >
                  <Feather name={route.icon as any} size={16} color={colors.textMuted} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{route.label}</Text>
                    <Text style={styles.rowDetail}>{route.detail}</Text>
                  </View>
                  <Feather name="chevron-right" size={17} color={colors.textMuted} />
                </Pressable>
              ))}
            </GlassCard>
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  content: { paddingBottom: 36 },
  card: { marginHorizontal: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  error: { color: colors.error, fontSize: 12, lineHeight: 17, marginTop: 10 },
  route: { minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  routeBorder: { borderTopWidth: 1, borderTopColor: colors.glassBorder },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  profileActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  profileButton: { borderWidth: 1, borderColor: colors.glassBorder, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  profileButtonText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  disabledCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginHorizontal: 20, marginTop: 8 },
})
