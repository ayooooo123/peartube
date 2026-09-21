import { createPublisherKeyVault } from './publisher-key-vault'
import { createPublisherSignerBridge } from './publisher-signer-bridge'

export type NativePublisherKeyVault = {
  getPublicKey(input?: { publisherId?: string }): Promise<Uint8Array | null>
  signProtocolRecord(input?: {
    publisherId?: string
    recordType?: string
    recordId?: Uint8Array
    transitionId?: Uint8Array
  }): Promise<{ signerPublicKey: Uint8Array; signature: Uint8Array }>
}

let signerPromise: Promise<unknown> | null = null

export function getNativePublisherSigner(): Promise<unknown> {
  if (!signerPromise) {
    signerPromise = Promise.resolve(createPublisherKeyVault() as NativePublisherKeyVault)
      .then((vault) => createPublisherSignerBridge({
        runtime: 'mobile-shell',
        vault,
      }))
  }
  return signerPromise
}
