import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }
const PUBLISHER_ID = 'd'.repeat(64)
const FIXTURE_BYTES = Buffer.from('fixture-bytes')
const FIXTURE_SHA256 = 'c16a40a4584e5bccc84b45172fcdfa922f59ff1edebf3adba7b8266ea04eb39a'

export async function createDeps (context) {
  const env = context.env || {}
  const duplicate = env.PEARTUBE_FAKE_DUPLICATE === '1'
  const expectedTitle = env.PEARTUBE_FAKE_EXPECT_TITLE || null
  const stageDir = mkdtempSync(join(tmpdir(), 'peartube-add-fake-'))
  const stagePath = join(stageDir, 'a.mkv')
  writeFileSync(stagePath, FIXTURE_BYTES)
  return {
    openAddRuntime: async () => ({
      ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
      close: async () => {}
    }),
    ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
    createMetadataProvider: async (authority) => ({
      async search () { return [] },
      async getShow () { return { name: 'Breaking Bad', mediaId: '1396', provider: authority, artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] }, { seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", airDate: '2008-01-27', artwork: [] }] },
      async getMovie () { return { title: 'The Matrix', mediaId: '603', provider: authority, year: 1999, artwork: [] } },
      async getRecording () { return { title: 'Paranoid Android', artist: 'Radiohead', mediaId: 'b1a9c0e8-2f9d-4b3e-9a24-6f3c1d9a7b55', provider: authority, firstReleaseDate: '1997-05-21', artwork: [] } },
      async getRelease () { return { title: 'OK Computer', artist: 'Radiohead', mediaId: '550e8400-e29b-41d4-a716-446655440000', provider: authority, date: '1997-05-21', artwork: [] } }
    }),
    resolveChannel: async () => CHANNEL,
    duplicateCheck: {
      check: async () => duplicate
        ? { status: 'already-exists', existing: { channelKey: 'chan-1', videoId: 'existing-9', availability: 'published' } }
        : { status: 'ok', advisories: [] }
    },
    arbitrateImportClaim: async () => ({ ok: true }),
    stageSource: async () => {
      console.log('[diag] downloading source (should go to stderr)')
      return {
        artifactPath: stagePath,
        checksum: `sha256:${FIXTURE_SHA256}`,
        title: 'a.mkv',
        dispose: null
      }
    },
    executeLocalFileAcquisition: async ({ input }) => {
      if (expectedTitle !== null && input.title !== expectedTitle) throw new Error('fixture title assertion failed')
      return {
        acquisitionId: `acq-${input.idempotencyKey}`,
        state: 'completed',
        publicationId: `vid-${input.idempotencyKey}`,
        manifestId: 'manifest-1',
        renditionId: 'rendition-1',
        assetId: 'asset-1'
      }
    }
  }
}
