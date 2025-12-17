/**
 * Semantic Finder - Embedding Generation and Search
 *
 * Generates embeddings for video titles/descriptions and provides semantic search.
 * Uses Hugging Face transformers.js embeddings when available, with a lightweight
 * fallback for runtimes that cannot load models.
 */

import b4a from 'b4a'
import { VectorIndex } from './vector-index.js'

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
const DEFAULT_DIMENSION = 384

/**
 * Semantic Finder for video search
 */
export class SemanticFinder {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.model] - transformers.js model id
   */
  constructor(opts = {}) {
    this.model = opts.model || DEFAULT_EMBEDDING_MODEL
    // Global fallback index (legacy callers)
    this.index = new VectorIndex()
    /** @type {Map<string, VectorIndex>} */
    this._channelIndexes = new Map()
    /** @type {Map<string, number>} channelKey -> last seen view core length */
    this._channelVectorViewLengths = new Map()
    this.initialized = false
    this._initPromise = null
    this._extractor = null
  }

  /**
   * Initialize the finder (load models if needed)
   */
  async init() {
    if (this.initialized) return
    if (this._initPromise) return this._initPromise

    this._initPromise = (async () => {
      // Default to hash embedding; upgrade to transformers.js when possible.
      try {
        // Hide module name from bare-pack static analysis by using string concatenation
        const transformersModule = '@xenova' + '/transformers'
        const mod = await import(/* webpackIgnore: true */ transformersModule)
        const { pipeline, env } = mod

        // Keep behavior permissive across runtimes:
        // - If models are available locally/cached, allow loading them.
        // - If downloads are blocked/unavailable, we fall back gracefully.
        if (env) {
          env.allowLocalModels = true
        }

        // Feature extraction pipeline produces sentence embeddings with pooling.
        this._extractor = await pipeline('feature-extraction', this.model)

        // Try to detect embedding dimension at runtime; otherwise fall back to 384.
        try {
          const probe = await this._extractor('probe', { pooling: 'mean', normalize: true })
          const vec = probe?.data instanceof Float32Array ? probe.data : null
          const dim = vec?.length || DEFAULT_DIMENSION
          this.index.dimension = dim
        } catch {
          this.index.dimension = DEFAULT_DIMENSION
        }
      } catch (err) {
        // transformers.js not installed or model load failed — continue with fallback
        this._extractor = null
        this.index.dimension = DEFAULT_DIMENSION
      } finally {
        this.initialized = true
      }
    })()

    return this._initPromise
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    if (!this.initialized) await this.init()

    // transformers.js path (preferred)
    if (this._extractor) {
      try {
        const out = await this._extractor(text, { pooling: 'mean', normalize: true })
        const vec = out?.data
        if (vec instanceof Float32Array) return vec
        // Some runtimes may return plain arrays
        if (Array.isArray(vec)) return new Float32Array(vec)
      } catch {
        // fall through to fallback
      }
    }

    // Fallback: deterministic hash embedding (not truly semantic, but stable/offline)
    return this._simpleEmbed(text)
  }

  /**
   * Ensure a channel-specific index exists.
   * @param {string} channelKey
   * @returns {VectorIndex}
   */
  _getChannelIndex(channelKey) {
    if (!channelKey) return this.index
    const existing = this._channelIndexes.get(channelKey)
    if (existing) return existing
    const idx = new VectorIndex()
    // Keep dimension in sync with the embedder
    idx.dimension = this.index.dimension || DEFAULT_DIMENSION
    this._channelIndexes.set(channelKey, idx)
    return idx
  }

  /**
   * Decode a base64-encoded Float32Array vector into a Float32Array.
   * @param {string} base64
   * @returns {Float32Array|null}
   */
  _decodeVector(base64) {
    if (!base64 || typeof base64 !== 'string') return null
    try {
      const buf = b4a.from(base64, 'base64')
      if (!buf || buf.byteLength % 4 !== 0) return null
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      // Copy into a standalone buffer to avoid retaining the larger underlying ArrayBuffer
      return new Float32Array(f32)
    } catch {
      return null
    }
  }

  /**
   * Rebuild or update the local ANN index for a channel from the replicated view (`vectors/` prefix).
   * This is the persistence layer: vectors are replicated via Autobase ops, and re-indexed locally.
   *
   * @param {string} channelKey
   * @param {import('../channel/multi-writer-channel.js').MultiWriterChannel} channel
   */
  async ensureIndexedFromChannelView(channelKey, channel) {
    if (!channelKey || !channel?.view) return

    // Best-effort catch-up so we see newly replicated vector records.
    try {
      await Promise.race([
        channel.base?.update?.(),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ])
    } catch {}

    const viewLen = channel.view?.core?.length || 0
    const lastLen = this._channelVectorViewLengths.get(channelKey) || 0
    if (viewLen && viewLen === lastLen) return

    const idx = this._getChannelIndex(channelKey)
    idx.dimension = this.index.dimension || DEFAULT_DIMENSION

    // For now we do a full scan (bounded by number of videos). If needed, we can later
    // implement incremental scanning by keeping a last key cursor.
    idx.clear()

    const start = 'vectors/'
    const end = 'vectors/\xff'

    for await (const { value } of channel.view.createReadStream({ gt: start, lt: end })) {
      if (!value?.videoId) continue
      const vec = value.vector ? this._decodeVector(value.vector) : null
      if (!vec) continue
      if (vec.length !== idx.dimension) continue

      let meta = {}
      if (typeof value.metadata === 'string') {
        try { meta = JSON.parse(value.metadata) } catch {}
      }

      idx.add(value.videoId, vec, {
        channelKey,
        text: value.text || '',
        ...meta
      })
    }

    this._channelVectorViewLengths.set(channelKey, viewLen)
  }

  /**
   * Simple embedding using text hashing (fallback)
   * @param {string} text
   * @returns {Float32Array}
   */
  _simpleEmbed(text) {
    const normalized = text.toLowerCase().trim()
    const dimension = this.index.dimension || DEFAULT_DIMENSION
    const vector = new Float32Array(dimension)

    // Simple hash-based approach (not semantic, but works for basic search)
    for (let i = 0; i < dimension; i++) {
      let hash = 0
      for (let j = 0; j < normalized.length; j++) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(j) + i
        hash = hash & hash // Convert to 32bit integer
      }
      vector[i] = (hash % 1000) / 1000 - 0.5 // Normalize to [-0.5, 0.5]
    }

    // Normalize vector
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
    if (norm > 0) {
      for (let i = 0; i < dimension; i++) {
        vector[i] /= norm
      }
    }

    return vector
  }

  /**
   * Index a video
   * @param {string} videoId - Video ID
   * @param {string} title - Video title
   * @param {string} [description] - Video description
   * @param {any} [metadata] - Additional metadata
   */
  async indexVideo(videoId, title, description = '', metadata = {}) {
    const text = `${title} ${description}`.trim()
    const embedding = await this.embed(text)
    const channelKey = metadata?.channelKey || null
    const idx = channelKey ? this._getChannelIndex(channelKey) : this.index
    idx.dimension = this.index.dimension || DEFAULT_DIMENSION
    idx.add(videoId, embedding, {
      videoId,
      title,
      description,
      ...metadata
    })
  }

  /**
   * Remove a video from the index
   * @param {string} videoId
   */
  removeVideo(videoId) {
    this.index.remove(videoId)
  }

  /**
   * Search for videos
   * @param {string} query - Search query
   * @param {number} topK - Number of results
   * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
   */
  async search(query, topK = 10, options = {}) {
    const queryEmbedding = await this.embed(query)
    const channelKey = options?.channelKey || null
    const idx = channelKey ? this._getChannelIndex(channelKey) : this.index
    return idx.search(queryEmbedding, topK)
  }

  /**
   * Get index size
   * @returns {number}
   */
  size() {
    return this.index.size()
  }

  /**
   * Clear the index
   */
  clear() {
    this.index.clear()
  }
}
