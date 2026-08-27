export function createConsumerWorkRevalidator({
  verifiedQueryView,
  scopedNetwork,
  getArchiveNetwork,
} = {}) {
  if (typeof verifiedQueryView?.getPublication !== 'function' ||
      typeof verifiedQueryView?.isVisible !== 'function' ||
      typeof scopedNetwork?.revalidateRetainedRenditions !== 'function') {
    throw new TypeError('consumer work revalidation dependencies are required')
  }

  return async function revalidateConsumerWork() {
    const assets = await scopedNetwork.revalidateRetainedRenditions()
    const archiveNetwork = getArchiveNetwork?.()
    const archive = await archiveNetwork?.revalidateConsumerRequests?.(async request => {
      const publication = await verifiedQueryView.getPublication({
        publicationId: request.body.publicationId,
      })
      return Boolean(publication && await verifiedQueryView.isVisible(publication))
    })
    return { assets, archive }
  }
}
