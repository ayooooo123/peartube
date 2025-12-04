/**
 * Desktop Header - Top navigation bar for Pear desktop
 *
 * Contains:
 * - Hamburger menu (toggle sidebar)
 * - PearTube logo
 * - Centered search bar
 * - Upload button
 * - User avatar
 */
import React, { useState, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { colors } from '@/lib/colors'
import { useSidebar, HEADER_HEIGHT } from './constants'

// Icon components (simple SVG-based)
function MenuIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function UserIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

export function DesktopHeader() {
  const router = useRouter()
  const { toggleSidebar } = useSidebar()
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      // TODO: Navigate to search results
      console.log('Search:', searchQuery)
    }
  }, [searchQuery])

  const handleLogoClick = useCallback(() => {
    router.push('/')
  }, [router])

  const handleUploadClick = useCallback(() => {
    router.push('/studio')
  }, [router])

  return (
    <header style={styles.header}>
      {/* Left section - hamburger + logo */}
      <div style={styles.leftSection}>
        <button
          style={styles.iconButton}
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <MenuIcon />
        </button>

        <button
          style={styles.logoButton}
          onClick={handleLogoClick}
          aria-label="Go to home"
        >
          <span style={styles.logoText}>PearTube</span>
        </button>
      </div>

      {/* Center section - search */}
      <div style={styles.centerSection}>
        <form onSubmit={handleSearch} style={styles.searchForm}>
          <div
            style={{
              ...styles.searchContainer,
              borderColor: isSearchFocused ? colors.primary : colors.border,
            }}
          >
            <input
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setIsSearchFocused(false)}
              style={styles.searchInput}
            />
            <button type="submit" style={styles.searchButton} aria-label="Search">
              <SearchIcon />
            </button>
          </div>
        </form>
      </div>

      {/* Right section - upload + user */}
      <div style={styles.rightSection}>
        <button
          style={styles.iconButton}
          onClick={handleUploadClick}
          aria-label="Upload video"
        >
          <UploadIcon />
        </button>

        <button
          style={styles.avatarButton}
          aria-label="User menu"
        >
          <UserIcon />
        </button>
      </div>
    </header>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: HEADER_HEIGHT,
    padding: '0 16px',
    backgroundColor: colors.bg,
    borderBottom: `1px solid ${colors.border}`,
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  leftSection: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    minWidth: 200,
  },
  centerSection: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    maxWidth: 640,
    margin: '0 24px',
  },
  rightSection: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 200,
    justifyContent: 'flex-end',
  },
  iconButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    borderRadius: 20,
    border: 'none',
    backgroundColor: 'transparent',
    color: colors.text,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  logoButton: {
    display: 'flex',
    alignItems: 'center',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: 0,
  },
  logoText: {
    fontSize: 20,
    fontWeight: 700,
    color: colors.text,
    letterSpacing: -0.5,
  },
  searchForm: {
    width: '100%',
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderRadius: 20,
    border: '1px solid',
    overflow: 'hidden',
    transition: 'border-color 0.15s ease',
  },
  searchInput: {
    flex: 1,
    height: 40,
    padding: '0 16px',
    border: 'none',
    backgroundColor: 'transparent',
    color: colors.text,
    fontSize: 14,
    outline: 'none',
  },
  searchButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 64,
    height: 40,
    border: 'none',
    borderLeft: `1px solid ${colors.border}`,
    backgroundColor: colors.bgHover,
    color: colors.text,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  avatarButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 16,
    border: 'none',
    backgroundColor: colors.bgSecondary,
    color: colors.textSecondary,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
}

export default DesktopHeader
