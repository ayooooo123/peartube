import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../moderation/profile.js'
import { personalSettingDigest } from './personal-store.js'

const MIGRATION_VERSION = 1
const JOURNAL_PREFIX = 'migration:device-local-profile:journal:v1:'
const MARKER_PREFIX = 'migration:device-local-profile:marker:v1:'
const MAX_SOURCE_REVISIONS = 8

export { personalSettingDigest }

export function profileMigrationJournalKey(targetId) {
  return `${JOURNAL_PREFIX}${String(targetId)}`
}

export function profileMigrationMarkerKey(targetId) {
  return `${MARKER_PREFIX}${String(targetId)}`
}

function sourceProfileVersion(record) {
  const profileVersion = Number(record?.value?.profile?.version)
  if (Number.isSafeInteger(profileVersion) && profileVersion >= 0) return profileVersion
  return null
}

function migrationState({ sourceId, targetId, record, phase }) {
  return {
    version: MIGRATION_VERSION,
    sourceId: String(sourceId),
    targetId: String(targetId),
    sourceVersion: record.revision,
    sourceProfileVersion: sourceProfileVersion(record),
    sourceDigest: record.digest,
    phase,
  }
}

/**
 * Copy one encrypted device-local profile to its identity PersonalStore.
 * The source remains authoritative until the target copy and commit marker
 * verify, and compare-and-delete prevents a concurrent newer source write from
 * being removed.
 */
export async function migrateDeviceLocalProfile({
  source,
  target,
  sourceId,
  targetId,
} = {}) {
  if (!source?.writable || !target?.writable) return null
  const journalKey = profileMigrationJournalKey(targetId)
  const markerKey = profileMigrationMarkerKey(targetId)

  for (let attempt = 0; attempt < MAX_SOURCE_REVISIONS; attempt++) {
    const record = await source.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (!record) {
      const marker = await target.getSetting(markerKey)
      await source.deleteSetting(journalKey)
      return marker || null
    }

    const prepared = migrationState({ sourceId, targetId, record, phase: 'prepared' })
    await source.setSetting(journalKey, prepared)
    await target.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, record.value)

    const copiedRecord = await target.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (!copiedRecord || copiedRecord.digest !== record.digest) {
      throw new Error('PersonalStore profile migration target verification failed')
    }
    await source.setSetting(journalKey, { ...prepared, phase: 'copied' })

    const committed = { ...prepared, phase: 'committed' }
    await target.setSetting(markerKey, committed)
    const durableMarker = await target.getSetting(markerKey)
    if (
      durableMarker?.sourceDigest !== record.digest ||
      durableMarker?.sourceVersion !== record.revision ||
      durableMarker?.phase !== 'committed'
    ) {
      throw new Error('PersonalStore profile migration marker verification failed')
    }
    await source.setSetting(journalKey, committed)

    const latest = await source.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (
      !latest ||
      latest.revision !== record.revision ||
      latest.digest !== record.digest
    ) continue
    await source.deleteSettingIfVersionAndDigest(
      CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      record.revision,
      record.digest,
    )

    const remaining = await source.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (remaining) continue
    await source.setSetting(journalKey, { ...committed, phase: 'source-deleted' })
    await source.deleteSetting(journalKey)
    return committed
  }

  throw new Error('PersonalStore profile migration source changed too frequently')
}
