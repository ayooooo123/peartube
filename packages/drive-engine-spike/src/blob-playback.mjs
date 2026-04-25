import BlobServer from 'hypercore-blob-server'

export async function createBlobPlaybackServer({ store }) {
  const server = new BlobServer(store, {
    port: 0,
    host: '127.0.0.1',
    anyPort: true
  })
  await server.listen()
  return server
}

export function getHyperdriveFileUrl({ server, driveKey, filename, mimeType = 'application/octet-stream' }) {
  if (!server) throw new Error('server is required')
  if (!driveKey) throw new Error('driveKey is required')
  if (typeof filename !== 'string' || !filename.startsWith('/')) {
    throw new Error('filename must be an absolute drive path')
  }

  return server.getLink(driveKey, {
    filename,
    type: mimeType
  })
}
