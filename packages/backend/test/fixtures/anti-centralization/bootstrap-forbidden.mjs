export const trustedRelayKeys = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
export const defaultTrustedIndexes = ['https://index.example.test/catalog']
export const trustedModerationFeeds = ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
export const defaultUploadOrigin = 'https://upload.example.test'
export const defaultMediaOrigin = 'https://media.example.test'
export const trustedRootIds = process.env.PEARTUBE_TRUSTED_ROOTS.split(',')

export function startBootstrapServer(candidate, trustedCatalogs, mediaServer) {
  trustedCatalogs.add(candidate.catalogBootstrapKey)
  return mediaServer.serveMediaBytes(candidate.mediaBytes)
}
