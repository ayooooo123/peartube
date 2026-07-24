// Search API group, extracted from api.js.
// Keeps the main API file focused while injecting the local helpers that still
// serve other indexing paths in api.js.
import b4a from 'b4a'
import { FederatedSearch } from '../search/federated-search.js'
function assertContextRunning(ctx) {
  if (ctx?.lifecycle?.signal?.aborted) throw new Error('Backend is shutting down')
}

export function createSearchApi({
  ctx,
  ensureSemanticFinder,
  buildSearchEnvelope,
  getPreviewVideoFromFeed,
  isMultiWriterChannelKey,
  loadChannel,
}) {
  return {
    /**
     * Search videos in a channel using semantic search
     * @param {string} channelKey
     * @param {string} query
     * @param {Object} [options]
     * @param {number} [options.topK=10]
     * @param {boolean} [options.federated=true]
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async searchVideos(channelKey, query, options = {}) {
      const { topK = 10, federated = true } = options

      // Ensure semantic finder is initialized with persistence
      await ensureSemanticFinder(ctx)
      assertContextRunning(ctx)

      // Initialize federated search if not already done
      if (!ctx.federatedSearch && ctx.swarm) {
        const federatedSearch = new FederatedSearch(ctx.swarm, ctx.semanticFinder)
        const ownership = ctx?.ownResource?.('federated search', federatedSearch, 'close', 5000)
          || ctx?.lifecycle?.ownResource?.('federated search', federatedSearch, 'close', 5000)
          || null
        ctx.federatedSearch = federatedSearch
        try {
          const channelKeyBuf = b4a.from(channelKey, 'hex')
          federatedSearch.setupTopic(channelKeyBuf)
          assertContextRunning(ctx)
        } catch (error) {
          if (ctx.federatedSearch === federatedSearch) ctx.federatedSearch = null
          await ownership?.cleanup?.()
          throw error
        }
      }

      // Use federated search if available, otherwise local only
      const results = ctx.federatedSearch && federated
        ? await ctx.federatedSearch.search(query, { topK, federated, timeout: 5000 })
        : await ctx.semanticFinder.search(query, topK)
      assertContextRunning(ctx)
      return results
    },

    /**
     * Global search across ALL discovered channels (YouTube-Fast)
     * Uses pre-built global index for O(1) search instead of iterating channels
     * @param {string} query - Search query
     * @param {Object} [options]
     * @param {number} [options.topK=50] - Max results to return
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async globalSearchVideos(query, options = {}) {
      const { topK = 50 } = options

      console.log('[API] globalSearchVideos:', query, 'topK:', topK)

      // Ensure semantic finder is initialized with persistence
      const finder = await ensureSemanticFinder(ctx)

      // Best-effort: import replicated vectors from any loaded channels.
      if (ctx.channels && ctx.channels.size > 0) {
        (async () => {
          for (const [channelKey, channel] of ctx.channels.entries()) {
            try {
              await finder.ensureGlobalIndexedFromChannelView(channelKey, channel)
            } catch { /* best effort */ }
          }
        })()
      }

      // Fast global search - O(1) not O(channels)
      const results = await finder.globalSearch(query, topK)
      console.log('[API] globalSearchVideos: found', results.length, 'results in global index')

      // Validate/enrich results when cheap, but do not prune preview/direct-ref
      // entries just because PublicBee/channel hydration timed out. Search may
      // have a durable preview record while loadChannel/listVideos is currently
      // unproductive over P2P.
      const validated = []
      const staleIds = []
      for (const r of results) {
        const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
        const channelKey = meta.channelKey || meta.driveKey
        if (!channelKey) { validated.push(r); continue }
        const hasDirectRefs = Boolean(meta.blobId && meta.blobsCoreKey)
        const previewVideo = getPreviewVideoFromFeed(channelKey, r.id, meta.publicBeeKey)
        if (hasDirectRefs || previewVideo?.blobId) {
          validated.push({
            ...r,
            metadata: {
              ...meta,
              ...(previewVideo || {}),
              channelKey,
              publicBeeKey: meta.publicBeeKey || previewVideo?.publicBeeKey || null,
              blobId: meta.blobId || previewVideo?.blobId || null,
              blobsCoreKey: meta.blobsCoreKey || previewVideo?.blobsCoreKey || null,
            },
          })
          continue
        }
        try {
          const video = await this.getVideoData(channelKey, r.id, meta.publicBeeKey)
          if (video) { validated.push(r); continue }
        } catch { /* best effort */ }
        staleIds.push(r.id)
      }

      if (staleIds.length > 0) {
        console.log('[API] globalSearchVideos: pruning', staleIds.length, 'stale entries')
        for (const id of staleIds) {
          try { finder.removeVideo(id) } catch { /* best effort */ }
        }
      }

      return validated
    },

    /**
     * Index a video for semantic search (YouTube-Fast)
     * Uses global index with persistence for instant search
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean}>}
     */
    async indexVideoVectors(channelKey, videoId) {
      try {
        const envelope = await buildSearchEnvelope(channelKey, videoId, { includeComments: true, includeSubtitles: true })
        if (!envelope) {
          return { success: false, error: 'Video not found' }
        }

        const finder = await ensureSemanticFinder(ctx)
        const needsMetadataRefresh =
          typeof finder.needsMetadataRefresh === 'function'
            ? finder.needsMetadataRefresh(envelope)
            : false

        if (finder.hasVideo(envelope.videoId) && !needsMetadataRefresh) {
          return { success: true, alreadyIndexed: true }
        }

        await finder.indexEnvelope(envelope, {
          channelKey,
          publicBeeKey: envelope.publicBeeKey || null,
        })

        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
          const channel = await loadChannel(ctx, channelKey)
          const text = envelope.searchText || `${envelope.title || ''} ${envelope.description || ''}`
          const embedding = await finder.embed(text)
          const vectorBase64 = b4a.toString(
            b4a.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            'base64'
          )

          await channel.base.append({
            type: 'add-vector-index',
            schemaVersion: 1,
            videoId: envelope.videoId,
            vector: vectorBase64,
            text,
            metadata: JSON.stringify({
              channelKey,
              title: envelope.title,
              creatorName: envelope.creatorName || null,
              channelName: envelope.channelName || null,
              sources: envelope.sourceFields
            }),
            indexedAt: Date.now()
          })
        }

        return { success: true }
      } catch (err) {
        console.error('[API] indexVideoVectors error:', err.message)
        return { success: false, error: err.message }
      }
    },
  }
}
