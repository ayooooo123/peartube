export const BUN_PERSONAL_SECRET_SERVICE = 'peartube.personal-encryption.v1'
const MAX_PERSONAL_SECRET_RECORD_BYTES = 4096

type AsyncKeyringEntry = {
  getPassword(): Promise<string | null>
  setPassword(value: string): Promise<void>
  deletePassword?: () => Promise<void>
  deleteCredential?: () => Promise<void>
}

type AsyncKeyringConstructor = new (service: string, account: string) => AsyncKeyringEntry

type PersonalSecretVaultOptions = {
  keyringLoader?: () => Promise<{ AsyncEntry?: AsyncKeyringConstructor }>
}

function assertPersonalSecretAccount(account: unknown): string {
  if (
    typeof account !== 'string' ||
    !/^peartube\.personal\.enc\.(?:device-local|[0-9a-f]{64})$/.test(account)
  ) {
    throw new Error('invalid-personal-secret-account')
  }
  return account
}

function assertPersonalSecretRecord(value: unknown): string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_PERSONAL_SECRET_RECORD_BYTES
  ) {
    throw new Error('invalid-personal-secret-record')
  }
  return value
}

async function loadKeyring(
  loader: PersonalSecretVaultOptions['keyringLoader'] =
    () => import('@napi-rs/keyring') as Promise<{ AsyncEntry?: AsyncKeyringConstructor }>,
) {
  const keyring = await loader()
  if (typeof keyring?.AsyncEntry !== 'function') throw new Error('personal-keyring-unavailable')
  return keyring
}

export function createBunPersonalSecretVault(options: PersonalSecretVaultOptions = {}) {
  async function entryFor(account: string): Promise<AsyncKeyringEntry> {
    const keyring = await loadKeyring(options.keyringLoader)
    return new keyring.AsyncEntry(
      BUN_PERSONAL_SECRET_SERVICE,
      assertPersonalSecretAccount(account),
    )
  }

  return Object.freeze({
    async get(account: string) {
      const value = await (await entryFor(account)).getPassword()
      if (value == null) return null
      return assertPersonalSecretRecord(value)
    },

    async set(account: string, value: string) {
      await (await entryFor(account)).setPassword(assertPersonalSecretRecord(value))
    },

    async delete(account: string) {
      const entry = await entryFor(account)
      if (typeof entry.deletePassword === 'function') {
        await entry.deletePassword()
      } else if (typeof entry.deleteCredential === 'function') {
        await entry.deleteCredential()
      } else {
        throw new Error('personal-keyring-delete-unavailable')
      }
    },
  })
}
