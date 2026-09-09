/**
 * Desktop Layout - Main layout wrapper for the Electrobun desktop shell.
 *
 * Layout structure:
 * - Title-bar inset (macOS traffic-light clearance)
 * - Header (56px) - wordmark, search, cast, profile; 2px rule underneath
 * - Sidebar (240px/72px) - collapsible navigation; 2px rule on its right edge
 * - Content - main content area on the black base
 */
import React, { useState, useCallback, useMemo } from 'react'
import { DesktopHeader } from './DesktopHeader.web'
import { DesktopSidebar } from './DesktopSidebar.web'
import { colors } from '@/lib/colors'
import {
  TITLEBAR_INSET,
  SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  SidebarContext,
} from './constants'

// Re-export constants for convenience
export {
  TITLEBAR_INSET,
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
  const [isCollapsed, setIsCollapsed] = useState(false)

  const toggleSidebar = useCallback(() => {
    setIsCollapsed(prev => !prev)
  }, [])

  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  const sidebarContextValue = useMemo(
    () => ({ isCollapsed, toggleSidebar }),
    [isCollapsed, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={sidebarContextValue}>
      <div style={styles.container}>
        <DesktopHeader />

        <div style={styles.mainArea}>
          <DesktopSidebar />

          <main
            style={{
              ...styles.content,
              marginLeft: sidebarWidth,
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    paddingTop: TITLEBAR_INSET,
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  mainArea: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    backgroundColor: colors.bg,
    transition: 'margin-left 0.15s ease',
  },
}

export default DesktopLayout
