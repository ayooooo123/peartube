import { createTorBoxSourceClient } from './torbox-source.js'
import { createFileSourceClient } from './file-source.js'
import nodeFs from 'node:fs'

/**
 * Registry of direct ingest source providers for PearTube Relay.
 * Decouples provider credentials from the public wire protocol.
 */
export class SourceProviderRegistry {
  constructor ({
    config = {},
    fs = null,
    fetchImpl = globalThis.fetch,
    legacySourceClient = null
  } = {}) {
    this.config = config
    this.fs = fs || nodeFs
    this.fetchImpl = fetchImpl
    this.legacySourceClient = legacySourceClient

    this._torboxClient = null
    this._fileClient = null
  }

  getTorBoxClient () {
    if (this._torboxClient) return this._torboxClient
    const apiKey = this.config.sources?.torbox?.apiKey ||
      process.env.PEARTUBE_TORBOX_API_KEY ||
      ''
    if (!apiKey) {
      throw new Error('TorBox direct ingest is requested, but no TorBox API key is configured (set PEARTUBE_TORBOX_API_KEY or sources.torbox.apiKey)')
    }
    this._torboxClient = createTorBoxSourceClient({
      apiKey,
      chunkBytes: this.config.sources?.torbox?.chunkBytes,
      fetchImpl: this.fetchImpl
    })
    return this._torboxClient
  }

  getFileClient () {
    if (this._fileClient) return this._fileClient
    const fileConfig = this.config.sources?.file || {}
    this._fileClient = createFileSourceClient({
      fs: this.fs,
      chunkBytes: fileConfig.chunkBytes,
      allowedPaths: fileConfig.allowedPaths || [],
      defaultWebdavBase: fileConfig.webdavBase || '',
      webdavUsername: fileConfig.webdavUsername || process.env.PEARTUBE_WEBDAV_USER || '',
      webdavPassword: fileConfig.webdavPassword || process.env.PEARTUBE_WEBDAV_PASS || '',
      fetchImpl: this.fetchImpl
    })
    return this._fileClient
  }

  /**
   * Resolves the appropriate source client and normalized parameters for a job attachment.
   */
  resolveSourceClient (attachment = {}) {
    const descriptor = attachment?.sourceDescriptor || null
    if (descriptor && typeof descriptor === 'object') {
      const provider = String(descriptor.provider || '').toLowerCase().trim()
      if (provider === 'torbox') {
        const client = this.getTorBoxClient()
        const params = {
          torrentId: descriptor.torrentId ?? descriptor.itemId,
          fileId: descriptor.fileId ?? descriptor.fileIndex ?? 0
        }
        return {
          type: 'direct',
          client: {
            chunkBytes: client.chunkBytes,
            head: (opts = {}) => client.head({ ...params, ...opts }),
            getRange: (opts = {}) => client.getRange({ ...params, ...opts }),
            revoke: () => client.revoke()
          },
          params
        }
      }
      if (provider === 'file' || provider === 'local-file' || provider === 'webdav') {
        const client = this.getFileClient()
        const params = {
          filePath: descriptor.filePath || null,
          webdavUrl: descriptor.webdavUrl || null,
          webdavPath: descriptor.webdavPath || null
        }
        return {
          type: 'direct',
          client: {
            chunkBytes: client.chunkBytes,
            head: (opts = {}) => client.head({ ...params, ...opts }),
            getRange: (opts = {}) => client.getRange({ ...params, ...opts }),
            revoke: () => client.revoke()
          },
          params
        }
      }
      throw new Error(`Unsupported direct ingest source provider: "${provider}"`)
    }

    if (attachment?.sourceCapability) {
      if (!this.legacySourceClient) {
        throw new Error('Legacy reciprocal source callback is unconfigured')
      }
      return {
        type: 'legacy',
        client: this.legacySourceClient,
        params: {
          capability: attachment.sourceCapability
        }
      }
    }

    return null
  }
}

export function createSourceProviderRegistry (options = {}) {
  return new SourceProviderRegistry(options)
}
export { createTorBoxSourceClient, createFileSourceClient }
