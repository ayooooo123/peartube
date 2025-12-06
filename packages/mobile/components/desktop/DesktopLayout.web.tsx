/**
 * Desktop Layout - Main layout wrapper for Pear desktop
 *
 * Layout structure:
 * - Pear Bar (52px) - handled by inject-pear-bar.js
 * - Header (56px) - search, logo, upload
 * - Sidebar (240px/72px) - collapsible navigation
 * - Content - main content area
 */
import React, { useState, useCallback } from 'react'
import { DesktopHeader } from './DesktopHeader.web'
import { DesktopSidebar } from './DesktopSidebar.web'
import { colors } from '@/lib/colors'
import {
  SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  SidebarContext,
} from './constants'

// Re-export constants for convenience
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
  const [isCollapsed, setIsCollapsed] = useState(false)

  const toggleSidebar = useCallback(() => {
    setIsCollapsed(prev => !prev)
  }, [])

  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  return (
    <SidebarContext.Provider value={{ isCollapsed, toggleSidebar }}>
      <div style={styles.container}>
        {/* Header - below pear bar */}
        <DesktopHeader />

        {/* Main content area */}
        <div style={styles.mainArea}>
          {/* Sidebar */}
          <DesktopSidebar />

          {/* Content */}
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
    transition: 'margin-left 0.2s ease',
  },
}

export default DesktopLayout
