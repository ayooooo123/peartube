/**
 * Desktop Sidebar - Collapsible navigation for Pear desktop
 *
 * Features:
 * - Collapsible: 240px expanded, 72px collapsed
 * - Navigation sections: Main, Your content
 * - Active state highlighting
 * - Smooth width transition
 * - Icon-only mode when collapsed with tooltips
 */
import React, { useCallback } from 'react'
import { useRouter, usePathname } from 'expo-router'
import { colors } from '@/lib/colors'
import {
  useSidebar,
  SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  HEADER_HEIGHT,
  PEAR_BAR_HEIGHT,
} from './constants'

// Icon components
function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function PlaySquareIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  )
}

function FilmIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
  { path: '/subscriptions', icon: UsersIcon, label: 'Subscriptions' },
]

const yourContentItems: NavItem[] = [
  { path: '/studio', icon: FilmIcon, label: 'Your videos' },
]

const bottomItems: NavItem[] = [
  { path: '/settings', icon: SettingsIcon, label: 'Settings' },
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
      onClick={onClick}
      style={{
        ...styles.navButton,
        backgroundColor: isActive ? colors.bgHover : 'transparent',
        justifyContent: isCollapsed ? 'center' : 'flex-start',
        padding: isCollapsed ? '12px' : '12px 16px',
      }}
      title={isCollapsed ? item.label : undefined}
      aria-label={item.label}
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

        {/* Divider */}
        <div style={styles.divider} />

        {/* Your content section */}
        <div style={styles.section}>
          {!isCollapsed && (
            <span style={styles.sectionLabel}>You</span>
          )}
          {yourContentItems.map((item) => (
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
    top: PEAR_BAR_HEIGHT + HEADER_HEIGHT, // Account for pear bar + header
    bottom: 0,
    backgroundColor: colors.bg,
    borderRight: `1px solid ${colors.border}`,
    transition: 'width 0.2s ease',
    overflowX: 'hidden',
    overflowY: 'auto',
    zIndex: 50,
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '12px 0',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    padding: '0 8px',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    padding: '8px 16px 4px',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    margin: '12px 16px',
  },
  spacer: {
    flex: 1,
  },
  navButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    height: 48,
    border: 'none',
    borderRadius: 8,
    backgroundColor: 'transparent',
    color: colors.text,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
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
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
}

export default DesktopSidebar
