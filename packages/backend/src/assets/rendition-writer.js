import { createRenditionDescriptor } from './rendition.js'
import { createSegmentIndexDescriptor } from './segment-index.js'
import { createStaticAssetManifest, writeStaticAsset } from './static-core.js'

const PREFLIGHT_CORE = createStaticAssetManifest({
  treeHash: '00'.repeat(32),
  blockLength: 0,
  byteLength: 0,
})

function validateRenditionMetadata(input) {
  if (input.segments) {
    createSegmentIndexDescriptor({
      codec: input.segmentCodec || 'peartube-inline-segments-v1',
      mediaByteLength: Number.MAX_SAFE_INTEGER,
      entries: input.segments,
      indexCore: input.indexCore,
    })
  }

  createRenditionDescriptor({
    purpose: input.purpose,
    format: input.format,
    core: PREFLIGHT_CORE,
  })
}

export function createImmutableRenditionWriter(defaults = {}) {
  let initialized = false
  let openWrites = 0

  return {
    async initialize() {
      initialized = true
    },

    getOpenWriteCount() {
      return openWrites
    },

    async writeRendition(input = {}) {
      if (!initialized) throw new Error('rendition writer must initialize before writes')
      openWrites++
      let staticAsset = null
      try {
        validateRenditionMetadata(input)
        // A resumable opener REPLACES the source rather than joining it: the
        // offset it has to start at is only known once the staging core on disk
        // has been read, so bytes handed in up front could not have started in
        // the right place. Only the rendition that brought no source of its own
        // inherits the writer's opener — artwork writes carry their own bytes
        // and stay ordinary one-shot writes. Passing both on one write is left
        // to writeStaticAsset to refuse rather than silently resolved here.
        const source = input.source || defaults.source
        const resume = input.resume || (input.source ? null : defaults.resume) || null
        staticAsset = await writeStaticAsset({
          store: input.store || defaults.store,
          source,
          signal: input.signal || defaults.signal,
          offload: input.offload || defaults.offload || null,
          resume,
        })
        const segmentIndex = createSegmentIndexDescriptor({
          codec: input.segmentCodec || 'peartube-inline-segments-v1',
          mediaByteLength: staticAsset.descriptor.byteLength,
          entries: input.segments || [{
            timeStartMs: 0,
            durationMs: Number(input.durationMs || 1),
            byteStart: 0,
            byteEnd: staticAsset.descriptor.byteLength,
            independent: true,
          }],
          indexCore: input.indexCore,
        })
        const descriptor = createRenditionDescriptor({
          purpose: input.purpose,
          format: input.format,
          core: staticAsset.descriptor,
          segmentIndex,
        })
        return {
          descriptor,
          segmentIndex,
          core: staticAsset.core,
          staticAsset: staticAsset.descriptor,
          sealed: true,
          readOnly: true,
        }
      } catch (error) {
        if (staticAsset && !staticAsset.core.closed) {
          try {
            await staticAsset.core.close()
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'rendition failure and static core close failed'
            )
          }
        }
        throw error
      } finally {
        openWrites--
      }
    },
  }
}
