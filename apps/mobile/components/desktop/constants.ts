/**
 * Desktop Layout Constants and Context
 *
 * Shared between DesktopLayout, DesktopHeader, and DesktopSidebar
 */
import { createContext, useContext } from 'react'

// Layout constants
export const PEAR_BAR_HEIGHT = 52
export const HEADER_HEIGHT = 56
export const SIDEBAR_WIDTH = 240
export const SIDEBAR_COLLAPSED_WIDTH = 72

// Context for sidebar state
export interface SidebarContextType {
  isCollapsed: boolean
  toggleSidebar: () => void
}

export const SidebarContext = createContext<SidebarContextType>({
  isCollapsed: false,
  toggleSidebar: () => {},
})

export function useSidebar() {
  return useContext(SidebarContext)
}
