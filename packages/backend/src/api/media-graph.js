function notImplemented() {
  return { success: false, errorCode: 'MEDIA_GRAPH_NOT_READY', error: 'Media graph API is registered but projection storage is not wired yet' }
}

function emptyPage() {
  return { success: true, items: [], nextCursor: null }
}

export function createMediaGraphApi() {
  return {
    async getMediaEntity() {
      return notImplemented()
    },
    async getMediaCollection() {
      return notImplemented()
    },
    async getMediaCollectionItems() {
      return emptyPage()
    },
    async getMediaAgent() {
      return notImplemented()
    },
    async getAgentContributions() {
      return emptyPage()
    },
    async getPublicationSources() {
      return emptyPage()
    },
    async getClaimProvenance() {
      return notImplemented()
    },
    async setSourcePreference() {
      return notImplemented()
    },
  }
}
