import { createRenditionDescriptor } from './rendition.js'
import { createSegmentIndexDescriptor } from './segment-index.js'
import { writeStaticAsset } from './static-core.js'

export function createImmutableRenditionWriter() {
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
      try {
        const staticAsset = await writeStaticAsset({
          store: input.store,
          source: input.source,
          signal: input.signal,
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
      } finally {
        openWrites--
      }
    },
  }
}
