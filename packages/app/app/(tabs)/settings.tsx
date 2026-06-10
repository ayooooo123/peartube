import { Redirect } from 'expo-router'

// Settings moved to the Profile screen (avatar button in headers).
export default function SettingsRedirect() {
  return <Redirect href="/profile" />
}
