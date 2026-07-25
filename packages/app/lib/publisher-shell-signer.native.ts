import { createPublisherKeyVault } from './publisher-key-vault'
import { createPublisherSignerBridge } from './publisher-signer-bridge'

export type NativePublisherKeyVault = {
  importLegacyRootMigration(request: unknown): Promise<{
    version: number
    durable: boolean
    publicKey: unknown
    challengeSignature: unknown
  }>
}

let vaultPromise: Promise<NativePublisherKeyVault> | null = null
let signerPromise: Promise<unknown> | null = null

export function getNativePublisherKeyVault(): Promise<NativePublisherKeyVault> {
  if (!vaultPromise) vaultPromise = Promise.resolve(createPublisherKeyVault())
  return vaultPromise
}

export function getNativePublisherSigner(): Promise<unknown> {
  if (!signerPromise) {
    signerPromise = getNativePublisherKeyVault().then((vault) => createPublisherSignerBridge({
      runtime: 'mobile-shell',
      vault,
    }))
  }
  return signerPromise
}
