export type DeveloperModePreference = {
  read(): Promise<boolean>
  write(enabled: boolean): Promise<void>
}

export function createDeveloperModeState(preference: DeveloperModePreference) {
  let cachedEnabled: boolean | null = null
  let loading: Promise<boolean> | null = null
  const listeners = new Set<(enabled: boolean) => void>()

  async function read(): Promise<boolean> {
    if (cachedEnabled !== null) return cachedEnabled
    if (!loading) {
      loading = preference.read()
        .then((enabled) => {
          cachedEnabled = enabled
          return enabled
        })
        .finally(() => { loading = null })
    }
    return loading
  }

  async function set(enabled: boolean): Promise<void> {
    await preference.write(enabled)
    cachedEnabled = enabled
    listeners.forEach((listener) => listener(enabled))
  }

  return {
    cached: () => cachedEnabled,
    read,
    set,
    subscribe(listener: (enabled: boolean) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
