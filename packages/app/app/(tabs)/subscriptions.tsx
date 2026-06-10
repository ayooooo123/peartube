import { Redirect } from 'expo-router'

// Subscriptions now live in the Library tab.
export default function SubscriptionsRedirect() {
  return <Redirect href="/library?tab=channels" />
}
