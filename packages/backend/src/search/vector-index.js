/**
 * Local Vector Index Manager
 *
 * Manages a local approximate nearest neighbor (ANN) index for video embeddings.
 * Uses a simple in-memory index with cosine similarity for mobile compatibility.
 */

import b4a from 'b4a'

/**
 * Simple vector index using cosine similarity
 * For production, consider using hnswlib-node or FAISS bindings
 */
export class VectorIndex {
  constructor() {
    /** @type {Map<string, {vector: Float32Array, metadata: any}>} */
    this.vectors = new Map()
    this.dimension = 384 // Default dimension for sentence transformers
  }

  /**
   * Add a vector to the index
   * @param {string} id - Video ID or document ID
   * @param {Float32Array|number[]} vector - Embedding vector
   * @param {any} metadata - Associated metadata
   */
  add(id, vector, metadata = {}) {
    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector)
    if (vec.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vec.length}`)
    }
    this.vectors.set(id, { vector: vec, metadata })
  }

  /**
   * Remove a vector from the index
   * @param {string} id - Video ID or document ID
   */
  remove(id) {
    this.vectors.delete(id)
  }

  /**
   * Search for similar vectors
   * @param {Float32Array|number[]} queryVector - Query embedding
   * @param {number} topK - Number of results to return
   * @returns {Array<{id: string, score: number, metadata: any}>}
   */
  search(queryVector, topK = 10) {
    const query = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector)
    if (query.length !== this.dimension) {
      throw new Error(`Query vector dimension mismatch: expected ${this.dimension}, got ${query.length}`)
    }

    const results = []

    for (const [id, { vector, metadata }] of this.vectors.entries()) {
      const score = cosineSimilarity(query, vector)
      results.push({ id, score, metadata })
    }

    // Sort by score descending and return top K
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /**
   * Get vector count
   * @returns {number}
   */
  size() {
    return this.vectors.size
  }

  /**
   * Clear all vectors
   */
  clear() {
    this.vectors.clear()
  }

  /**
   * Serialize index to buffer (for persistence)
   * @returns {Buffer}
   */
  serialize() {
    const data = {
      dimension: this.dimension,
      vectors: Array.from(this.vectors.entries()).map(([id, { vector, metadata }]) => ({
        id,
        vector: Array.from(vector),
        metadata
      }))
    }
    return Buffer.from(JSON.stringify(data))
  }

  /**
   * Deserialize index from buffer
   * @param {Buffer} buffer
   */
  deserialize(buffer) {
    const data = JSON.parse(buffer.toString())
    this.dimension = data.dimension
    this.vectors.clear()
    for (const { id, vector, metadata } of data.vectors) {
      this.vectors.set(id, {
        vector: new Float32Array(vector),
        metadata
      })
    }
  }
}

/**
 * Compute cosine similarity between two vectors
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}
