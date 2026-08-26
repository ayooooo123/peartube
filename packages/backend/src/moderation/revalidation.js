export function createConsumerWorkRevalidator({
  mediaCatalogProjection,
  getConsumerCatalogProjection,
  scopedNetwork,
  getArchiveNetwork,
} = {}) {
  if (typeof getConsumerCatalogProjection !== 'function' ||
      typeof scopedNetwork?.revalidateRetainedRenditions !== 'function') {
    throw new TypeError('consumer work revalidation dependencies are required')
  }

  return async function revalidateConsumerWork() {
    await mediaCatalogProjection?.rebuild?.()
    const projection = getConsumerCatalogProjection()
    projection?.rebuild?.()
    const assets = await scopedNetwork.revalidateRetainedRenditions()
    const archiveNetwork = getArchiveNetwork?.()
    const archive = await archiveNetwork?.revalidateConsumerRequests?.(
      request => projection?.isPublicationVisible?.(request.body.publicationId) === true
    )
    return { assets, archive }
  }
}
