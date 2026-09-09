/**
 * Desktop Sidebar - Collapsible navigation for the desktop shell
 *
 * - 240px expanded, 72px collapsed, 2px rule on the right edge
 * - Mono uppercase labels; active row = lime text + 2px lime rule on the left
 * - Icon-only mode when collapsed, with native tooltips
 */
import React, { useCallback } from 'react'
import { useRouter, usePathname } from 'expo-router'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import {
  useSidebar,
  SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  HEADER_HEIGHT,
  TITLEBAR_INSET,
} from './constants'

// Icon components
function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <title>Home</title>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function DiscoverIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <title>Discover</title>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13 13 8.5 15.5 11 11 15.5 8.5" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <title>Subscriptions</title>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <title>Settings</title>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}


interface NavItem {
  path: string
  icon: React.FC
  label: string
}

const mainNavItems: NavItem[] = [
  { path: '/', icon: HomeIcon, label: 'Home' },
  { path: '/discover', icon: DiscoverIcon, label: 'Discover' },
  { path: '/library', icon: UsersIcon, label: 'Library' },
]

const bottomItems: NavItem[] = [
  { path: '/profile', icon: SettingsIcon, label: 'Profile' },
]

interface NavButtonProps {
  item: NavItem
  isActive: boolean
  isCollapsed: boolean
  onClick: () => void
}

function NavButton({ item, isActive, isCollapsed, onClick }: NavButtonProps) {
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.navButton,
        color: isActive ? colors.primary : colors.textSecondary,
        borderLeftColor: isActive ? colors.primary : 'transparent',
        justifyContent: isCollapsed ? 'center' : 'flex-start',
        padding: isCollapsed ? 0 : `0 ${spacing.lg}px`,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.surfaceHover }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
      title={isCollapsed ? item.label : undefined}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
    >
      <span style={styles.navIcon}>
        <Icon />
      </span>
      {!isCollapsed && (
        <span style={styles.navLabel}>{item.label}</span>
      )}
    </button>
  )
}

export function DesktopSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { isCollapsed } = useSidebar()

  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  const handleNavClick = useCallback((path: string) => {
    if (path === '/' && typeof window !== 'undefined' && window.location.hash) {
      window.location.hash = ''
      return
    }
    router.push(path as any)
  }, [router])

  const isActive = (path: string) => {
    if (path === '/') return pathname === '/'
    return pathname.startsWith(path)
  }

  return (
    <aside
      style={{
        ...styles.sidebar,
        width: sidebarWidth,
      }}
    >
      <nav style={styles.nav}>
        {/* Main navigation */}
        <div style={styles.section}>
          {mainNavItems.map((item) => (
            <NavButton
              key={item.path}
              item={item}
              isActive={isActive(item.path)}
              isCollapsed={isCollapsed}
              onClick={() => handleNavClick(item.path)}
            />
          ))}
        </div>

        {/* Spacer to push settings to bottom */}
        <div style={styles.spacer} />

        {/* Bottom navigation */}
        <div style={styles.section}>
          {bottomItems.map((item) => (
            <NavButton
              key={item.path}
              item={item}
              isActive={isActive(item.path)}
              isCollapsed={isCollapsed}
              onClick={() => handleNavClick(item.path)}
            />
          ))}
        </div>
      </nav>
    </aside>
  )
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    position: 'fixed',
    left: 0,
    top: TITLEBAR_INSET + HEADER_HEIGHT,
    bottom: 0,
    backgroundColor: colors.bg,
    borderRight: `${borderWidth.rule}px solid ${colors.border}`,
    transition: 'width 0.15s ease',
    overflowX: 'hidden',
    overflowY: 'auto',
    zIndex: 50,
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: `${spacing.md}px 0`,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
  },
  spacer: {
    flex: 1,
  },
  navButton: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
    height: 44,
    border: 'none',
    borderLeft: `${borderWidth.rule}px solid transparent`,
    borderRadius: 0,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, color 0.15s ease',
    textAlign: 'left',
  },
  navIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 24,
    height: 24,
  },
  navLabel: {
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
}

export default DesktopSidebar
