export function getAndroidDiscoveryPermissionRequests({ platformOS, platformVersion, permissions = {} } = {}) {
  if (platformOS !== 'android') return []
  const requests = []
  if (Number(platformVersion || 0) >= 33) {
    if (permissions.POST_NOTIFICATIONS) requests.push(permissions.POST_NOTIFICATIONS)
    if (permissions.NEARBY_WIFI_DEVICES) requests.push(permissions.NEARBY_WIFI_DEVICES)
  }
  return requests
}
