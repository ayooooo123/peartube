import b4a from 'b4a'

import {
  ACQUISITION_CONSENT_VERSION,
  acquisitionError,
  createAcquisitionManager,
  createAcquisitionPolicyRuntime,
  createAcquisitionStore,
  createSourceGrantVault,
  normalizeAcquisitionPolicy,
} from '../acquisition/index.js'
import { createProviderApi } from '../api/provider.js'
import { createStaticAssetManifest, verifyStaticAssetDescriptor, writeStaticAsset } from '../assets/static-core.js'
import { createSourceReader } from '../assets/source-reader.js'
import { createProviderService, issueLocalProviderResolution } from './service.js'
const ACQUISITION_POLICY_REVISION_KEY = 'acquisition/policy-revision/v1'

const ACQUISITION_POLICY_KEY = 'acquisition/policy/v1'

function unavailable(code, message) {
  throw acquisitionError(code, message, 503)
}

function hex(value, name) {
  const bytes = b4a.from(value || [])
  if (bytes.byteLength !== 32) throw new TypeError(`${name} must be 32 bytes`)
  return b4a.toString(bytes, 'hex')
}


function descriptorFromWrite(value) {
  const descriptor = value?.descriptor
  if (!descriptor) throw new Error('Static asset writer returned no descriptor')
  return {
    assetId: descriptor.assetId,
    key: hex(descriptor.key, 'asset key'),
    treeHash: hex(descriptor.treeHash, 'asset tree hash'),
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    blockSize: descriptor.blockSize,
  }
}

function staticDescriptor(asset) {
  const descriptor = createStaticAssetManifest({
    treeHash: asset.treeHash,
    blockLength: asset.length,
    byteLength: asset.byteLength,
    blockSize: asset.blockSize,
  })

  if (descriptor.assetId !== asset.assetId || b4a.toString(descriptor.key, 'hex') !== asset.key) {
    throw new Error('Static asset identity does not match its descriptor')
  }
  return descriptor
}
function delayUntilNextRateWindow(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      signal?.removeEventListener?.('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      const error = signal?.reason instanceof Error ? signal.reason : acquisitionError('ACQUISITION_CANCELLED', 'acquisition was cancelled', 499)
      reject(error)
    }
    if (signal?.aborted) aborted()
    else signal?.addEventListener?.('abort', aborted, { once: true })
  })
}

function createBudgetedSourceReader({ reader, resume, priorBytes = 0, maxBytesPerSecond, signal, onProgress }) {
  const source = createSourceReader(reader)
  const initialBytes = Math.max(resume?.byteLength || 0, priorBytes || 0)
  let sourceBytesRead = initialBytes
  let sourceBytesAccepted = initialBytes
  let windowStartedAt = 0
  let windowBytes = 0
  return createSourceReader({
    resumable: source.resumable,
    maxReadBytes: source.maxReadBytes,
    describe: input => source.describe(input),
    async * open(input) {
      let logicalOffset = input.offset
      for await (const value of source.open(input)) {
        const chunk = b4a.from(value)
        for (let offset = 0; offset < chunk.byteLength; offset += maxBytesPerSecond) {
          const part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + maxBytesPerSecond))
          const current = Date.now()
          if (windowStartedAt === 0) windowStartedAt = current
          if (current - windowStartedAt >= 1000) {
            windowStartedAt = current
            windowBytes = 0
          }
          if (windowBytes + part.byteLength > maxBytesPerSecond) {
            await delayUntilNextRateWindow(1010 - (current - windowStartedAt), signal || input.signal)
            windowStartedAt = Date.now()
            windowBytes = 0
          }
          windowBytes += part.byteLength
          logicalOffset += part.byteLength
          sourceBytesRead = Math.max(sourceBytesRead, logicalOffset)
          await onProgress?.({ sourceBytesRead, sourceBytesAccepted, bytesAcquired: sourceBytesAccepted, stagingBytes: 0 })
          yield part
          sourceBytesAccepted = Math.max(sourceBytesAccepted, logicalOffset)
        }
      }
      await onProgress?.({ sourceBytesRead, sourceBytesAccepted, bytesAcquired: sourceBytesAccepted, stagingBytes: 0 })
    },
    close: reason => source.close(reason),
  })
}

function validateSubsystemDependencies(ctx, uploadManager, mediaApi) {
  if (!ctx?.metaDb || !ctx?.store) throw new TypeError('provider subsystem requires backend storage')
  const uploadMethods = ['hasPublisherAuthority', 'publishAcquiredAsset', 'getAuthorizedPublisherIds', 'getAcquiredPublication']
  if (!uploadManager || !uploadMethods.every(method => typeof uploadManager[method] === 'function')) {
    throw new TypeError('provider subsystem requires acquisition publication support')
  }
  if (!mediaApi || typeof mediaApi.openMediaRenditionUrl !== 'function') {
    throw new TypeError('provider subsystem requires verified rendition streaming')
  }
}

async function createPolicyBinding(ctx, configuredPolicy, now) {
  const storedPolicy = (await ctx.metaDb.get(ACQUISITION_POLICY_KEY))?.value || configuredPolicy
  const storedRevision = (await ctx.metaDb.get(ACQUISITION_POLICY_REVISION_KEY))?.value
  let policyRevision = Number.isSafeInteger(storedRevision) && storedRevision >= 0 ? storedRevision : 0
  let policyWrites = Promise.resolve()
  const policyRuntime = createAcquisitionPolicyRuntime({ policy: storedPolicy, now })
  const acquisitionPolicy = Object.freeze({
    getPolicy: () => policyRuntime.getPolicy(),
    getRevision: () => policyRevision,
    admit: input => policyRuntime.admit(input),
    subscribe: listener => policyRuntime.subscribe(listener),
    setPolicy(input, { consent = null, expectedRevision = null } = {}) {
      const operation = policyWrites.then(async () => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          const error = new Error('Acquisition policy revision is required')
          error.code = 'ACQUISITION_POLICY_REVISION_REQUIRED'
          throw error
        }
        if (expectedRevision !== policyRevision) {
          const error = new Error('Acquisition policy revision changed')
          error.code = 'ACQUISITION_POLICY_REVISION_CONFLICT'
          throw error
        }
        const next = normalizeAcquisitionPolicy(input)
        const consentGranted = consent === true || (
          consent?.version === ACQUISITION_CONSENT_VERSION &&
          consent?.granted === true &&
          Object.keys(consent).every(key => key === 'version' || key === 'granted')
        )
        if ((next.enabled || !next.migrationRequired) && !consentGranted) {
          throw acquisitionError('ACQUISITION_CONSENT_REQUIRED', 'explicit current-version consent is required', 403)
        }
        const nextRevision = policyRevision + 1
        const batch = ctx.metaDb.batch()
        await batch.put(ACQUISITION_POLICY_KEY, next)
        await batch.put(ACQUISITION_POLICY_REVISION_KEY, nextRevision)
        await batch.flush()
        policyRevision = nextRevision
        return policyRuntime.setPolicy(next, { consent: true })
      })
      policyWrites = operation.catch(() => {})
      return operation
    },
  })
  return {
    acquisitionPolicy,
    acquisitionPolicyRevision: Object.freeze({ get: () => policyRevision }),
  }
}

function createTrustedPublisherResolver(configured, uploadManager) {
  if (typeof configured === 'function') return configured
  return async () => {
    const publisherIds = await uploadManager.getAuthorizedPublisherIds()
    if (publisherIds.length !== 1) unavailable('PROVIDER_PUBLISHER_SCOPE_UNAVAILABLE', 'Provider requires exactly one trusted publisher scope')
    return publisherIds[0]
  }
}

const UNAVAILABLE_SOURCE_RESOLVER = Object.freeze({
  async resolve() {
    unavailable('SOURCE_ADAPTER_UNAVAILABLE', 'No private source adapter is configured')
  },
})

export async function createProviderSubsystem({
  ctx,
  verifiedQueryView,
  indexVerificationRuntime,
  uploadManager,
  mediaApi,
  policy = null,
  config = {},
  now = () => Date.now(),
} = {}) {
  validateSubsystemDependencies(ctx, uploadManager, mediaApi)

  const store = createAcquisitionStore({ bee: ctx.metaDb, now })
  const { acquisitionPolicy, acquisitionPolicyRevision } = await createPolicyBinding(ctx, config.acquisitionPolicy, now)
  const sourceGrants = createSourceGrantVault({
    now,
    resolver: config.sourceGrantResolver || UNAVAILABLE_SOURCE_RESOLVER,
  })
  const resolveTrustedPublisherId = createTrustedPublisherResolver(config.resolveTrustedPublisherId, uploadManager)
  const customProvider = config.acquisitionProvider || null
  let service = null

  const acquisitionProvider = Object.freeze({
    async resolve({ ref }) {
      const resolved = await service.resolve({ ref })
      return {
        ...resolved,
        adapterId: customProvider?.adapterId ?? null,
      }
    },
    canOpen(input) {
      return customProvider?.canOpen?.(input) === true
    },
    async open(input) {
      if (typeof customProvider?.open !== 'function') unavailable('SOURCE_GRANT_REQUIRED', 'A private source grant is required')
      return customProvider.open(input)
    },
    async acquire(input) {
      if (typeof customProvider?.acquire === 'function') return customProvider.acquire(input)
      const maxBytesPerSecond = input.budget?.maxAcquireBytesPerSecond
      if (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond < 1) {
        unavailable('ACQUISITION_RATE_POLICY_REQUIRED', 'Acquisition rate policy is unavailable')
      }
      const resumableIngest = typeof ctx.blockOffload?.createOffloader === 'function' &&
        typeof ctx.blockOffload?.createStagingStore === 'function'
      const resume = (input.resume && resumableIngest) ? { id: input.acquisitionId, ...input.resume } : false
      let written = null
      try {
        written = await writeStaticAsset({
          store: ctx.store,
          reader: createBudgetedSourceReader({
            reader: input.reader,
            resume: input.resume,
            // A retried acquisition may already carry durable progress from a
            // prior attempt that died before it could set a verified prefix:
            // without this floor the writer's attempt-local counter restarts
            // at zero and the first progress patch regresses the durable
            // counter, failing the job as ACQUISITION_ACCOUNTING_REGRESSION
            // and discarding every byte the prior attempt already landed.
            priorBytes: input.priorBytes || 0,
            maxBytesPerSecond,
            signal: input.signal,
            onProgress: input.onProgress,
          }),
          signal: input.signal,
          offload: ctx.blockOffload || null,
          resume,
          // A grant-backed source is remote: re-reading it for pass 2 is a
          // second full download through the (possibly throttled) source.
          // Stage through the object store instead when it is configured.
          preferStaging: input.sourceExpensive === true,
        })
        return { descriptor: descriptorFromWrite(written), stagingBytes: 0 }
      } finally {
        await written?.core?.close?.().catch(() => {})
      }
    },
    async verify(input) {
      if (typeof customProvider?.verify === 'function') return customProvider.verify(input)
      const descriptor = staticDescriptor(input.asset)
      const core = ctx.store.get({ key: descriptor.key })
      try {
        await core.ready?.()
        const verified = await verifyStaticAssetDescriptor(core, descriptor)
        return { verified, byteLength: descriptor.byteLength }
      } finally {
        await core.close?.().catch(() => {})
      }
    },
    async discard(input) {
      await customProvider?.discard?.(input)
    },
  })

  const publisher = Object.freeze({
    hasAuthority({ publisherId }) {
      return uploadManager.hasPublisherAuthority({ publisherId })
    },
    getPublication(input) {
      return uploadManager.getAcquiredPublication(input)
    },
    async publish(input) {
      return uploadManager.publishAcquiredAsset({
        acquisitionId: input.acquisitionId,
        publisherId: input.request.publisherId,
        asset: input.asset,
        source: input.source,
        resolution: input.resolution,
        retentionClass: input.request.retentionClass,
        signal: input.signal,
      })
    },
  })

  const manager = createAcquisitionManager({
    store,
    policy: acquisitionPolicy,
    provider: acquisitionProvider,
    sourceGrants,
    publisher,
    network: config.managerNetwork || null,
    freeDiskBytes: typeof config.freeDiskBytes === 'function' ? config.freeDiskBytes : () => Number.MAX_SAFE_INTEGER,
    now,
  })

  const statusSource = config.statusSource || {
    async getStatus() {
      const acquisitionsByState = await store.countByState()
      return {
        ready: true,
        searchAvailable: true,
        acquisitionAvailable: (await acquisitionPolicy.getPolicy()).enabled === true,
        streamingAvailable: true,
        acquisitionsByState,
        activeAcquisitions: acquisitionsByState.acquiring + acquisitionsByState.verifying + acquisitionsByState.publishing,
        queuedAcquisitions: acquisitionsByState.queued,
        updatedAt: now(),
      }
    },
  }

  service = createProviderService({
    verifiedQueryView,
    indexVerificationRuntime,
    acquisitionManager: manager,
    async streamOpener({ publication, rendition }) {
      const opened = await mediaApi.openMediaRenditionUrl({
        publicationId: publication.publicationId,
        renditionId: rendition.renditionId,
      })
      if (!opened?.success) unavailable(opened?.errorCode || 'PROVIDER_STREAM_UNAVAILABLE', opened?.error || 'Verified rendition is unavailable')
      return { url: opened.url, ...(opened.etag ? { etag: opened.etag } : {}) }
    },
    policy,
    acquisitionPolicy,
    statusSource,
    now,
  })

  await manager.start()

  return Object.freeze({
    service,
    api: createProviderApi({
      providerService: service,
      principalId: config.principalId || 'local-provider',
      ...(typeof config.selectorForQuery === 'function' ? { selectorForQuery: config.selectorForQuery } : {}),
      ...(typeof config.decodeSourceGrant === 'function' ? { decodeSourceGrant: config.decodeSourceGrant } : {}),
      resolveTrustedPublisherId,
      acquisitionPolicyRevision,
    }),
    manager,
    issueLocalResolution(input) {
      return issueLocalProviderResolution(service, input)
    },
    retractPublication(input) {
      return uploadManager.retractAcquiredPublication?.(input)
    },
    store,
    acquisitionPolicy,
    sourceGrants,
    async close() {
      await manager.close()
      await sourceGrants.close()
    },
  })
}
