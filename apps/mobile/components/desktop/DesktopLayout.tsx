/**
 * Desktop Layout - Mobile stub
 *
 * On mobile platforms, this simply renders children without any desktop chrome.
 * The actual desktop layout is in DesktopLayout.web.tsx
 */
import React from 'react'
import { View } from 'react-native'

// Re-export constants for consistency
export {
  PEAR_BAR_HEIGHT,
  HEADER_HEIGHT,
  SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  useSidebar,
} from './constants'

interface DesktopLayoutProps {
  children: React.ReactNode
}

export function DesktopLayout({ children }: DesktopLayoutProps) {
  return <View style={{ flex: 1 }}>{children}</View>
}

export default DesktopLayout
