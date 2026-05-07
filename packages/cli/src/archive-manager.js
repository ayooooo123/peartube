import { spawn } from '#subprocess'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { mkdirSync, rmSync, existsSync } from '#fs'
import { join } from '#path'

const JOBS_KEY = 'relay-archive-jobs'
const PRIVATE_INPUTS_KEY = 'relay-archive-job-inputs'

function now() {
  return Date.now()
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function sanitizeUrl(value) {
  const url = String(value || '').trim()
  if (!url) throw new Error('archive url is required')
  if (!/^https?:\/\//i.test(url)) throw new Error('archive url must be http(s)')
  return url
}

function sanitizeName(value) {
  const name = String(value || '').trim()
  return name || 'Anonymous Archive'
}

function publicJob(job) {
  const { url, ...safe } = job || {}
  return safe
}

function makeJobId(url) {
  const digest = b4a.toString(crypto.hash(Buffer.from(`${url}:${now()}:${b4a.toString(crypto.randomBytes(8), 'hex')}`)), 'hex').slice(0, 16)
  return `arch_${digest}`
}

async function readValue(metaDb, key, fallback) {
  const entry = await metaDb.get(key).catch(() => null)
  return entry?.value ?? fallback
}

export function createArchiveJobStore({ metaDb }) {
  if (!metaDb) throw new Error('metaDb is required')

  async function readJobsRaw() {
    return safeArray(await readValue(metaDb, JOBS_KEY, []))
  }

  async function writeJobsRaw(jobs) {
    await metaDb.put(JOBS_KEY, safeArray(jobs).map(publicJob))
  }

  async function readPrivateInputs() {
    const raw = await readValue(metaDb, PRIVATE_INPUTS_KEY, {})
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  async function writePrivateInputs(inputs) {
    await metaDb.put(PRIVATE_INPUTS_KEY, inputs || {})
  }

  return {
    async listJobs() {
      return (await readJobsRaw()).map(publicJob)
    },
    async getPrivateInput(id) {
      const inputs = await readPrivateInputs()
      return inputs[id] || null
    },
    async addJob(job, privateInput) {
      const jobs = await readJobsRaw()
      jobs.unshift(publicJob(job))
      await writeJobsRaw(jobs)
      const inputs = await readPrivateInputs()
      inputs[job.id] = privateInput
      await writePrivateInputs(inputs)
      return publicJob(job)
    },
    async updateJob(id, patch) {
      const jobs = await readJobsRaw()
      const updated = jobs.map((job) => job.id === id ? publicJob({ ...job, ...patch, updatedAt: now() }) : job)
      await writeJobsRaw(updated)
      return updated.find((job) => job.id === id) || null
    }
  }
}

export async function enqueueArchiveJob(store, input = {}) {
  const url = sanitizeUrl(input.url)
  const createdAt = now()
  const job = {
    id: makeJobId(url),
    status: 'queued',
    channelName: sanitizeName(input.channelName),
    title: input.title ? String(input.title) : null,
    description: input.description ? String(input.description) : '',
    publish: input.publish !== false,
    anonymous: input.anonymous !== false,
    createdAt,
    updatedAt: createdAt,
    error: null
  }

  return store.addJob(job, {
    url,
    title: job.title,
    description: job.description,
    channelName: job.channelName,
    publish: job.publish,
    anonymous: job.anonymous
  })
}

export function createYtDlpDownloader({
  bin = 'yt-dlp',
  outputDir,
  format = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b',
  ffmpegPath = null,
  cookiesPath = null,
  jsRuntime = null,
  ytDlpExtraArgs = [],
  spawnFn = spawn,
  fs = { mkdirSync, rmSync, existsSync },
  path = { join }
} = {}) {
  if (!outputDir) throw new Error('outputDir is required')

  return {
    async download(input) {
      const id = input.id || makeJobId(input.url)
      const targetDir = path.join(outputDir, id)
      fs.mkdirSync(targetDir, { recursive: true })
      const outputTemplate = path.join(targetDir, '%(title).200B [%(id)s].%(ext)s')
      const args = [
        '--no-playlist',
        '--restrict-filenames',
        '--write-info-json',
        '--print', 'after_move:filepath',
        '-f', format,
        '--merge-output-format', 'mp4',
        '-o', outputTemplate
      ]
      if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath)
      if (cookiesPath) args.push('--cookies', cookiesPath)
      if (jsRuntime) args.push('--js-runtimes', jsRuntime)
      if (Array.isArray(ytDlpExtraArgs) && ytDlpExtraArgs.length) args.push(...ytDlpExtraArgs)
      args.push(input.url)

      const { stdout, stderr } = await new Promise((resolve, reject) => {
        const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout?.on('data', (chunk) => { out += String(chunk) })
        child.stderr?.on('data', (chunk) => { err += String(chunk) })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve({ stdout: out, stderr: err })
          else reject(new Error(`yt-dlp failed (${code}): ${err || out}`))
        })
      })

      const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      let filePath = null
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (line === 'filepath') continue
        if (line.startsWith('filepath ')) {
          filePath = line.slice('filepath '.length).trim()
          break
        }
        filePath = line
        break
      }
      if (!filePath) throw new Error('yt-dlp did not report an output file')
      if (typeof fs.existsSync === 'function' && !fs.existsSync(filePath)) {
        throw new Error(`yt-dlp reported output file does not exist: ${filePath}`)
      }

      return {
        filePath,
        title: input.title || filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Archived video',
        description: input.description || `Archived anonymously from ${new URL(input.url).hostname}`,
        mimeType: filePath.endsWith('.webm') ? 'video/webm' : 'video/mp4',
        cleanup() {
          try {
            fs.rmSync(targetDir, { recursive: true, force: true })
          } catch (err) {
            // Best effort: stale archive temp directories are harmless and can be cleaned on the next run.
          }
        }
      }
    }
  }
}

export function createArchivePublisher({ identityManager, uploadManager, api, runtime, fs }) {
  if (!identityManager) throw new Error('identityManager is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!api) throw new Error('api is required')

  return {
    async ensureAnonymousChannel({ channelName }) {
      let identity = identityManager.getActiveIdentity?.()
      if (!identity?.driveKey) {
        const created = await identityManager.createIdentity(channelName || 'Anonymous Archive', true)
        identity = {
          publicKey: created.publicKey,
          driveKey: created.driveKey,
          channelKey: created.driveKey,
          name: channelName || 'Anonymous Archive'
        }
      }

      const channel = await identityManager.getActiveChannel?.()
      if (!channel?.blobs) throw new Error('Anonymous channel blobs not initialized')
      const meta = await channel.getMetadata?.().catch(() => null)
      const publicBeeKey = channel.publicBeeKey || meta?.publicBeeKey || null
      return { channel, channelKey: identity.driveKey || identity.channelKey, publicBeeKey }
    },
    async importVideo({ channel, filePath, title, description, mimeType }) {
      const result = await uploadManager.uploadFromPath(channel, filePath, { title, description, mimeType, category: 'archive' }, fs)
      if (!result?.success) throw new Error(result?.error || 'Archive import failed')
      return result
    },
    async publishChannel({ channelKey }) {
      return api.submitToFeed(channelKey)
    },
    async seedChannel({ channelKey, publicBeeKey }) {
      if (channelKey && publicBeeKey) {
        await runtime?.cacheManager?.addChannel?.(channelKey, publicBeeKey, 'private').catch(() => {})
        await runtime?.publicFeed?.submitChannel?.(channelKey, publicBeeKey).catch(() => {})
        await runtime?.seeder?.seedChannel?.({ driveKey: channelKey, publicBeeKey }).catch(() => {})
      }
    }
  }
}

export function createArchiveManager({ store, downloader, publisher, logger = null }) {
  if (!store) throw new Error('store is required')
  if (!downloader) throw new Error('downloader is required')
  if (!publisher) throw new Error('publisher is required')

  return {
    enqueue(input) {
      return enqueueArchiveJob(store, input)
    },
    async runNext() {
      const jobs = await store.listJobs()
      const job = jobs.find((item) => item.status === 'queued' || item.status === 'failed')
      if (!job) return null
      return this.runJob(job.id)
    },
    async runJob(id) {
      const privateInput = await store.getPrivateInput(id)
      if (!privateInput?.url) throw new Error(`Archive job ${id} has no private URL input`)
      await store.updateJob(id, { status: 'running', error: null })
      let downloaded = null

      try {
        downloaded = await downloader.download({ id, ...privateInput })
        const channelInfo = await publisher.ensureAnonymousChannel(privateInput)
        const imported = await publisher.importVideo({
          ...downloaded,
          ...privateInput,
          channel: channelInfo.channel,
          title: privateInput.title || downloaded.title,
          description: privateInput.description || downloaded.description
        })

        if (privateInput.publish !== false) {
          await publisher.publishChannel(channelInfo)
          await publisher.seedChannel(channelInfo)
        }

        const completed = await store.updateJob(id, {
          status: 'completed',
          title: privateInput.title || downloaded.title,
          videoId: imported.videoId,
          channelKey: channelInfo.channelKey,
          publicBeeKey: channelInfo.publicBeeKey || null,
          completedAt: now(),
          error: null
        })
        return completed
      } catch (err) {
        logger?.archive?.error?.('Archive job failed', { id, error: err?.message || String(err) })
        const failed = await store.updateJob(id, { status: 'failed', error: err?.message || String(err) })
        return failed
      } finally {
        try {
          downloaded?.cleanup?.()
        } catch (err) {
          // Best effort: import result is already persisted before cleanup runs.
        }
      }
    }
  }
}
