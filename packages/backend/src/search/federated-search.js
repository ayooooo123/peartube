/**
 * Federated Search Coordinator
 *
 * Coordinates distributed search across multiple peers via Hyperswarm.
 * Each peer searches locally and results are merged client-side.
 */

import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import Protomux from 'protomux'
import c from 'compact-encoding'

/**
 * Federated search coordinator
 */
export class FederatedSearch {
  /**
   * @param {import('hyperswarm')} swarm - Hyperswarm instance
   * @param {import('./semantic-finder.js').SemanticFinder} finder - Local semantic finder
   * @param {Object} [opts]
   * @param {(channelKey: string) => Promise<void>} [opts.ensureIndexed] - Ensure local channel index is ready before searching/responding
   */
  constructor(swarm, finder, opts = {}) {
    this.swarm = swarm
    this.finder = finder
    this.ensureIndexed = typeof opts.ensureIndexed === 'function' ? opts.ensureIndexed : null
    this.searchTopic = null
    /** @type {Map<string, {resultSets: Array<Array>, timeoutId: any, resolve: Function}>} */
    this.pendingQueries = new Map() // queryId -> aggregation state

    /** @type {Map<any, any>} conn -> protomux channel */
    this.peerChannels = new Map()
    this._connectionHandler = null
  }

  static protocolName() {
    return 'peartube-search-v1'
  }

  /**
   * Set up search topic for federated search
   * @param {Buffer} channelKey - Channel key for topic derivation
   */
  setupTopic(channelKey) {
    // Derive search topic from channel key
    const topic = crypto.data(b4a.concat([b4a.from('peartube-search', 'utf-8'), channelKey]))
    this.searchTopic = topic

    if (!this.swarm) return

    // Join discovery for federated search
    try {
      this.swarm.join(this.searchTopic, { server: true, client: true })
    } catch {}

    // Wire protocol on current + future connections
    if (!this._connectionHandler) {
      this._connectionHandler = (conn, info) => {
        this._handleConnection(conn, info)
      }
      this.swarm.on('connection', this._connectionHandler)
    }

    // Existing connections (e.g. established before setupTopic)
    for (const conn of this.swarm.connections) {
      this._handleConnection(conn, {})
    }
  }

  _handleConnection(conn, info) {
    if (!conn || this.peerChannels.has(conn)) return

    const mux = Protomux.from(conn)
    const protocol = FederatedSearch.protocolName()

    mux.pair({ protocol }, () => {
      this._createSearchChannel(mux, conn)
    })

    // Also try opening from our side
    this._createSearchChannel(mux, conn)

    conn.on('close', () => {
      this.peerChannels.delete(conn)
    })
    conn.on('error', () => {
      this.peerChannels.delete(conn)
    })
  }

  _createSearchChannel(mux, conn) {
    if (this.peerChannels.has(conn)) return

    const channel = mux.createChannel({
      protocol: FederatedSearch.protocolName(),
      messages: [{
        encoding: c.json,
        onmessage: (msg) => this._handleMessage(msg, conn)
      }],
      onopen: () => {
        // Channel ready for requests
      },
      onclose: () => {
        this.peerChannels.delete(conn)
      }
    })

    if (!channel) return
    this.peerChannels.set(conn, channel)
    channel.open()
  }

  async _handleMessage(msg, conn) {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'SEARCH_QUERY' && msg.queryId && typeof msg.query === 'string') {
      const channelKey = typeof msg.channelKey === 'string' ? msg.channelKey : null
      const topK = typeof msg.topK === 'number' ? msg.topK : 10

      try {
        if (this.ensureIndexed && channelKey) {
          await this.ensureIndexed(channelKey)
        }
      } catch {}

      let results = []
      try {
        results = await this.finder.search(msg.query, topK, channelKey ? { channelKey } : {})
      } catch {
        results = []
      }

      const ch = this.peerChannels.get(conn)
      if (!ch) return
      try {
        ch.messages[0].send({
          type: 'SEARCH_RESPONSE',
          queryId: msg.queryId,
          results
        })
      } catch {}
    } else if (msg.type === 'SEARCH_RESPONSE' && msg.queryId) {
      const pending = this.pendingQueries.get(msg.queryId)
      if (!pending) return
      const results = Array.isArray(msg.results) ? msg.results : []
      pending.resultSets.push(results)
    }
  }

  /**
   * Search locally and optionally broadcast to peers
   * @param {string} query - Search query
   * @param {Object} [options]
   * @param {number} [options.topK=10] - Number of results
   * @param {boolean} [options.federated=true] - Whether to search peers
   * @param {number} [options.timeout=5000] - Timeout for federated search in ms
   * @param {string} [options.channelKey] - Channel key to scope the search
   * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
   */
  async search(query, options = {}) {
    const {
      topK = 10,
      federated = true,
      timeout = 5000,
      channelKey = null
    } = options

    try {
      if (this.ensureIndexed && channelKey) {
        await this.ensureIndexed(channelKey)
      }
    } catch {}

    // Search locally first
    const localResults = await this.finder.search(query, topK, channelKey ? { channelKey } : {})

    if (!federated || !this.swarm || !this.searchTopic) {
      return localResults
    }

    // Broadcast query to peers and collect results
    const peerResults = await this._broadcastSearch(query, topK, timeout, channelKey)

    // Merge results: combine local and peer results, deduplicate by ID, re-rank
    return this._mergeResults(localResults, peerResults, topK)
  }

  /**
   * Broadcast search query to peers
   * @param {string} query
   * @param {number} topK
   * @param {number} timeout
   * @returns {Promise<Array<Array>>}
   */
  async _broadcastSearch(query, topK, timeout, channelKey) {
    const queryId = b4a.toString(crypto.randomBytes(16), 'hex')

    // Snapshot of current peers with protocol channels open
    const channels = Array.from(this.peerChannels.values())

    return new Promise((resolve) => {
      const state = {
        resultSets: [],
        resolve,
        timeoutId: null
      }

      state.timeoutId = setTimeout(() => {
        this.pendingQueries.delete(queryId)
        resolve(state.resultSets)
      }, timeout)

      this.pendingQueries.set(queryId, state)

      const msg = {
        type: 'SEARCH_QUERY',
        queryId,
        channelKey: channelKey || null,
        query,
        topK
      }

      for (const ch of channels) {
        try {
          ch.messages[0].send(msg)
        } catch {}
      }
    })
  }

  /**
   * Merge local and peer search results
   * @param {Array} localResults
   * @param {Array<Array>} peerResults
   * @param {number} topK
   * @returns {Array}
   */
  _mergeResults(localResults, peerResults, topK) {
    const merged = new Map()

    // Add local results
    for (const result of localResults) {
      merged.set(result.id, result)
    }

    // Add peer results (aggregate scores for duplicates)
    for (const peerResultSet of peerResults) {
      for (const result of peerResultSet) {
        const existing = merged.get(result.id)
        if (existing) {
          // Average scores for duplicates
          existing.score = (existing.score + result.score) / 2
        } else {
          merged.set(result.id, result)
        }
      }
    }

    // Sort by score and return top K
    const sorted = Array.from(merged.values()).sort((a, b) => b.score - a.score)
    return sorted.slice(0, topK)
  }

  // Incoming peer queries are handled by the protomux channel `onmessage` handler.
}
