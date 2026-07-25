type NativePublisherKeyVault = {
  importLegacyRootMigration(request: unknown): Promise<{
    version: number
    durable: boolean
    publicKey: unknown
    challengeSignature: unknown
  }>
}

function unavailable(): never {
  throw new Error('Publisher key vault is available only in the native shell')
}

export async function getNativePublisherKeyVault(): Promise<NativePublisherKeyVault> {
  return unavailable()
}

export async function getNativePublisherSigner(): Promise<unknown> {
  return unavailable()
}
