import test from 'brittle'
import fs from 'node:fs'

import { APP_RPC_METADATA } from '../spec/hrpc/app-rpc-adapter.mjs'

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
const messageFields = (schema, name) => {
  const message = schema.schema.find((entry) => entry.name === name)
  return new Set(message?.fields?.map((field) => field.name) ?? [])
}

const COMMANDS = [
  'get-migration-status',
  'retry-migration',
  'export-migration-report',
  'get-publisher-device-status',
  'export-portable-state',
  'restore-portable-state',
  'preview-storage-limit',
  'get-archive-operator-status'
]

test('operability commands and grouped app metadata are generated', (t) => {
  const hrpc = readJson('../spec/hrpc/hrpc.json')
  const commands = new Set(hrpc.schema.map((entry) => entry.name.replace('@peartube/', '')))
  for (const command of COMMANDS) t.ok(commands.has(command), `${command} is registered`)

  const grouped = Object.fromEntries(
    Object.entries(APP_RPC_METADATA.namespaces).map(([namespace, methods]) => [
      namespace,
      new Set(methods.map((method) => method.command))
    ])
  )
  for (const command of COMMANDS.slice(0, 3)) t.ok(grouped.system?.has(command), `${command} is grouped under system`)
  for (const command of COMMANDS.slice(3, 6)) t.ok(grouped.publisher?.has(command), `${command} is grouped under publisher`)
  for (const command of COMMANDS.slice(6)) t.ok(grouped.transfer?.has(command), `${command} is grouped under transfer`)
})

test('operability responses use bounded structured fields and public-only portability data', (t) => {
  const schema = readJson('../spec/schema/schema.json')

  for (const field of [
    'success', 'migrationId', 'state', 'version', 'processedCount', 'importedCount',
    'skippedCount', 'quarantinedCount', 'unsupportedCount', 'remainingCount', 'retryable',
    'updatedAt', 'errorCode', 'errorMessage', 'reportDigest'
  ]) t.ok(messageFields(schema, 'get-migration-status-response').has(field), `migration status has ${field}`)
  t.ok(messageFields(schema, 'retry-migration-response').has('joined'), 'retry response reports a joined in-flight retry')
  for (const field of ['success', 'migrationId', 'reportBytes', 'reportDigest', 'errorCode']) {
    t.ok(messageFields(schema, 'export-migration-report-response').has(field), `migration report has ${field}`)
  }

  for (const field of [
    'success', 'publisherId', 'devicePublicKey', 'status', 'reasonCode', 'canPublish',
    'canPlayLocal', 'canExportLocal', 'canDeleteLocal', 'canRootTransition', 'catalogEpoch',
    'policyEpoch', 'admissionExpiresAt', 'revocationCutoff', 'legacyImportState'
  ]) t.ok(messageFields(schema, 'get-publisher-device-status-response').has(field), `publisher device status has ${field}`)

  for (const field of ['success', 'schemaVersion', 'manifestBytes', 'manifestDigest', 'itemCount', 'errorCode']) {
    t.ok(messageFields(schema, 'export-portable-state-response').has(field), `portable export has ${field}`)
  }
  for (const field of ['success', 'schemaVersion', 'importedCount', 'skippedCount', 'idempotent', 'errorCode', 'error']) {
    t.ok(messageFields(schema, 'restore-portable-state-response').has(field), `portable restore has ${field}`)
  }

  const portableFields = schema.schema
    .filter((entry) => /portable-state/.test(entry.name))
    .flatMap((entry) => entry.fields.map((field) => field.name.toLowerCase()))
  t.absent(portableFields.find((field) => /secret|private|rootkey|root-key/.test(field)), 'portable contracts expose no secret/root-key field')

  const schemaSource = fs.readFileSync(new URL('../schema.cjs', import.meta.url), 'utf8')
  t.ok(schemaSource.includes('MAX_MIGRATION_REPORT_BYTES = 65_536'), 'migration reports have an explicit 64 KiB contract bound')
  t.ok(schemaSource.includes('MAX_PORTABLE_MANIFEST_BYTES = 1_048_576'), 'portable manifests have an explicit 1 MiB contract bound')
  t.ok(schemaSource.includes('MAX_PORTABLE_ITEMS = 2_048'), 'portable manifests have an explicit item bound')
  t.ok(schemaSource.includes('MAX_STORAGE_PREVIEW_ITEMS = 32'), 'storage preview arrays have an explicit contract bound')
  t.ok(schemaSource.includes('MAX_ARCHIVE_OPERATOR_ITEMS = 64'), 'archive operator arrays have an explicit contract bound')
  t.ok(schemaSource.includes('MAX_PUBLICATION_SOURCE_REASONS = 32'), 'publication source diagnostic arrays have an explicit contract bound')
})

test('publication sources, storage stats, previews, and archive status are structured', (t) => {
  const schema = readJson('../spec/schema/schema.json')
  for (const field of [
    'selected', 'selectionReasonCodes', 'rejectionReasonCodes', 'introductionPublisherIds',
    'introductionIndexIds', 'moderationFeedIds', 'claimConflictIds', 'provenanceClaimIds',
    'score', 'availabilityScore', 'formatSupport', 'moderationPenalty',
    'scoreLocalCompleteness', 'scoreStartupReachability', 'scorePeerEvidence',
    'scoreFormatSupport', 'scoreStartupLatency', 'scoreUserOverride',
    'eligible', 'archiveState', 'cacheState',
    'availabilityState', 'stale', 'incomplete'
  ]) t.ok(messageFields(schema, 'media-publication-source').has(field), `publication source has ${field}`)

  const availability = schema.schema.find((entry) => entry.name === 'media-availability')
  const requiredAvailabilityFields = new Set([
    'state', 'observedAt', 'expiresAt', 'requiredRangeCount', 'reachableRangeCount',
    'independentPeerCount', 'completePeerCount', 'measuredLatencyMs', 'reasonCodes'
  ])
  for (const field of availability?.fields || []) {
    if (requiredAvailabilityFields.has(field.name)) {
      t.is(field.required, true, `availability ${field.name} is explicit on every frame`)
    }
  }
  t.is(
    [...requiredAvailabilityFields].every((name) => availability?.fields?.some((field) => field.name === name)),
    true,
    'availability frames contain every required non-boolean contract field'
  )

  for (const field of [
    'ownedOriginalBytes', 'immutablePublicationBytes', 'pledgedArchiveBytes', 'localCacheBytes',
    'thumbnailBytes', 'indexBytes', 'temporaryTransferBytes', 'totalCategorizedBytes',
    'evictableBytes', 'protectedBytes'
  ]) t.ok(messageFields(schema, 'get-storage-stats-response').has(field), `storage stats has ${field}`)

  for (const field of [
    'success', 'requestedMaxBytes', 'currentUsedBytes', 'requiredEvictionBytes', 'evictableBytes',
    'protectedBytes', 'affectedSeedCount', 'affectedCategories', 'consequences', 'feasible', 'errorCode'
  ]) t.ok(messageFields(schema, 'preview-storage-limit-response').has(field), `storage preview has ${field}`)

  for (const field of [
    'success', 'operatorMode', 'activePledgeCount', 'healthyPledgeCount', 'failedPledgeCount',
    'challengeSuccessCount', 'challengeFailureCount', 'capacityTotalBytes',
    'capacityReservedBytes', 'capacityAvailableBytes', 'capacityRejectionCount',
    'offloadRejectionCount', 'recentFailureCodes', 'updatedAt', 'errorCode'
  ]) t.ok(messageFields(schema, 'get-archive-operator-status-response').has(field), `archive operator status has ${field}`)
})
