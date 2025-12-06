/**
 * Desktop Sidebar Navigation
 *
 * A vertical side menu for desktop platforms (Pear Runtime).
 * Follows desktop UX patterns with icon + label navigation.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { usePathname, router } from 'expo-router'
import { Home, Film, Users, Settings } from 'lucide-react-native'
import { colors } from '@/app/_layout'

interface NavItem {
  name: string
  path: string
  icon: typeof Home
  label: string
}

const navItems: NavItem[] = [
  { name: 'index', path: '/', icon: Home, label: 'Home' },
  { name: 'subscriptions', path: '/subscriptions', icon: Users, label: 'Subscriptions' },
  { name: 'studio', path: '/studio', icon: Film, label: 'Studio' },
  { name: 'settings', path: '/settings', icon: Settings, label: 'Settings' },
]

export function DesktopSidebar() {
  const pathname = usePathname()

  const isActive = (item: NavItem) => {
    if (item.path === '/') {
      return pathname === '/' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
    }
    return pathname === item.path || pathname === `/(tabs)${item.path}`
  }

  return (
    <View style={styles.sidebar}>
      {navItems.map((item) => {
        const active = isActive(item)
        const Icon = item.icon

        return (
          <Pressable
            key={item.name}
            style={[styles.navItem, active && styles.navItemActive]}
            onPress={() => router.push(item.path as any)}
          >
            <Icon
              size={20}
              color={active ? colors.primary : colors.textMuted}
              style={styles.navIcon}
            />
            <Text style={[styles.navLabel, active && styles.navLabelActive]}>
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  sidebar: {
    width: 200,
    backgroundColor: colors.bgSecondary,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 4,
  },
  navItemActive: {
    backgroundColor: colors.bgHover,
  },
  navIcon: {
    marginRight: 12,
  },
  navLabel: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '500',
  },
  navLabelActive: {
    color: colors.text,
  },
})
