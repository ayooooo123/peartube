import { Redirect } from 'expo-router'

// Downloads now live in the Library tab.
export default function DownloadsRedirect() {
  return <Redirect href="/library?tab=downloads" />
}
