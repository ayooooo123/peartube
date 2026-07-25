export function getAndroidDiscoveryPermissionRequests(options?: {
  platformOS?: string
  platformVersion?: string | number
  permissions?: Record<string, string>
}): string[]
