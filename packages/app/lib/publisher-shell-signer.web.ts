export async function getNativePublisherSigner(): Promise<unknown> {
  throw new Error('Publisher key vault is available only in the native shell')
}
