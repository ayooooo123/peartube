import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChannel } from '@peartube/backend/storage'
import { deriveImportClaimantId } from '@peartube/backend/structured-content'
import { createContentPublication } from '@peartube/backend/content-publication'
import { createYtDlpDownloader } from '../archive-manager.js'
import { fingerprintFile } from './bulk/source-scanner.js'
import { itemIdentity } from './duplicate-check.js'

// Wires the executor's injected seams to the live universal backend: channel
// resolution, real yt-dlp / local download, real upload as a private
// replicationPending draft, deterministic import claims, and (when a trusted
// relay is configured) durability + publication.
export function createBackendExecutorDeps ({ runtime, jobStore, preferences, fetchUrl, emitProgress = () => {} }) {
  const ctx = runtime.ctx
  const identityManager = runtime.identityManager
  const uploadManager = runtime.uploadManager
  const publicFeed = runtime.publicFeed
  let channelRef = null
  let publication = null

  async function ensureChannel () {
    if (channelRef) return channelRef
    let identity = identityManager.getActiveIdentity?.() || identityManager.getIdentities?.()[0]
    if (!identity) {
      emitProgress('Creating your channel')
      const created = await identityManager.createIdentity('My PearTube', true, {})
      identity = identityManager.getActiveIdentity?.() || {
        channelKey: created.driveKey,
        channelWriterKeyName: `peartube-channel-writer:${created.publicKey}`,
        channelEncryptionKey: created.channelEncryptionKey || null
      }
    }
    const channelKey = identity.channelKey || identity.driveKey
    // createIdentity caches the writable channel in ctx.channels; reuse it to
    // avoid reopening the Corestore session.
    channelRef = ctx.channels?.get?.(channelKey) || await loadChannel(ctx, channelKey, {
      writerKeyName: identity.channelWriterKeyName || null,
      encryptionKeyHex: identity.channelEncryptionKey || null,
      preferWritable: true
    })
    return channelRef
  }

  function channelHandle (channel) {
    return channel && channel._channel ? channel._channel : channelRef
  }
  async function publicationFor (channel) {
    if (!publication) publication = createContentPublication({ channel, publicFeed })
    return publication
  }

  return {
    jobStore,

    async resolveChannel () {
      const channel = await ensureChannel()
      return {
        channelKey: channel.keyHex,
        writerKeyHex: channel.localWriterKeyHex,
        publicBeeKey: channel.publicBeeKey || (await channel.getPublicBeeKey?.().catch(() => null)),
        _channel: channel
      }
    },

    async loadChannel () {
      const channel = await ensureChannel()
      return { channelKey: channel.keyHex, writerKeyHex: channel.localWriterKeyHex, publicBeeKey: channel.publicBeeKey, _channel: channel }
    },

    duplicateCheck: {
      async check ({ channel, item }) {
        const ch = channelHandle(channel)
        const identity = itemIdentity(item)
        if (ch && identity && typeof ch.listVideos === 'function') {
          const videos = await ch.listVideos().catch(() => [])
          const match = videos.find((video) => itemIdentity({
            contentKind: video.contentKind,
            seasonNumber: video.seasonNumber,
            episodeNumber: video.episodeNumber,
            sourceProvider: video.sourceProvider,
            sourceVideoId: video.sourceVideoId,
            identityUrl: video.identityUrl
          }) === identity)
          if (match) {
            return { status: 'already-exists', existing: { channelKey: ch.keyHex, videoId: match.id, availability: match.publicationState || 'published' } }
          }
        }
        return { status: 'ok', advisories: [] }
      }
    },

    deriveImportClaimantId,

    async writeClaim ({ channel, identityKey, claimantId, jobId }) {
      const ch = channelHandle(channel)
      await ch.putImportClaim({ identityKey, claimantId, jobId, writerKey: ch.localWriterKeyHex })
    },

    async resolveClaimWinner ({ channel, identityKey }) {
      const ch = channelHandle(channel)
      return ch.resolveImportClaim(identityKey)
    },

    async downloadSource () {
      if (fetchUrl && fs.existsSync(fetchUrl)) {
        emitProgress('Using local source file')
        return { artifactPath: fetchUrl, checksum: await fingerprintFile(fetchUrl) }
      }
      emitProgress(`Downloading ${fetchUrl}`)
      const outputDir = mkdtempSync(join(tmpdir(), 'peartube-add-dl-'))
      const downloader = createYtDlpDownloader({
        bin: preferences.ytDlpPath,
        outputDir,
        format: 'bv*+ba/b',
        cookiesPath: preferences.ytDlpCookiesPath || null
      })
      const result = await downloader.download({ url: fetchUrl })
      return { artifactPath: result.filePath, checksum: await fingerprintFile(result.filePath), title: result.title }
    },

    async uploadFromPath ({ channel, videoId, path, identityUrl, importIdentityKey, importClaimantId, item = {} }) {
      const ch = channelHandle(channel)
      const options = pruneUndefined({
        videoId,
        title: item.title || 'Untitled',
        description: item.description || '',
        publicationState: 'replicationPending',
        contentKind: item.contentKind || 'video',
        sourceProvider: item.sourceProvider || 'local',
        sourceVideoId: item.sourceVideoId || videoId,
        identityUrl: identityUrl || undefined,
        importIdentityKey,
        importClaimantId,
        seasonNumber: Number.isInteger(item.seasonNumber) ? item.seasonNumber : undefined,
        episodeNumber: Number.isInteger(item.episodeNumber) ? item.episodeNumber : undefined
      })
      const result = await uploadManager.uploadFromPath(ch, path, options, fs, (pct) => emitProgress(`Uploading ${pct}%`))
      if (!result?.success) throw new Error(result?.error || 'Upload failed')
      return { videoId: result.videoId, channelKey: ch.keyHex, blobKey: ch.blobsKeyHex }
    },

    async requestPin () {
      // Pinning + durability are driven by awaitDurable via content replication.
    },

    async awaitDurable ({ channel, videoId }) {
      const trusted = (preferences.network?.trustedRelayKeys || [])
      if (trusted.length === 0) {
        emitProgress('No trusted relay configured; keeping the draft local (replicationPending).')
        return { verified: false }
      }
      // Trusted-relay durability path is driven by content replication.
      const ch = channelHandle(channel)
      const verified = await runReplication({ runtime, channel: ch, videoId, jobStore, preferences, emitProgress })
      return verified
    },

    publication: {
      async markDurabilityVerified (videoId) { return (await publicationFor(channelRef)).markDurabilityVerified(videoId) },
      async project (input) { return (await publicationFor(channelRef)).project(input) },
      async announce (input) { return (await publicationFor(channelRef)).announce(input) },
      async finalize (videoId) { return (await publicationFor(channelRef)).finalize(videoId) }
    }
  }
}

function pruneUndefined (object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value
  return out
}

// Placeholder for the trusted-relay durability drive; wired in the relay step.
async function runReplication () {
  return { verified: false }
}
