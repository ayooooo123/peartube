/**
 * Sidebar Navigation Component
 */

import React from 'react';
import { colors, spacing, radius, layout } from '../../lib/theme';
import { Column, Text, Avatar, Divider } from '../ui';

export type NavItem = {
  id: string;
  label: string;
  icon: string;
  badge?: number;
};

interface SidebarProps {
  activeItem: string;
  onNavigate: (id: string) => void;
  collapsed?: boolean;
  identity?: { name?: string; publicKey: string };
  subscriptions?: { driveKey: string; name: string }[];
  onSubscriptionClick?: (driveKey: string) => void;
}

const navItems: NavItem[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'trending', label: 'Trending', icon: '🔥' },
  { id: 'subscriptions', label: 'Subscriptions', icon: '📺' },
];

const libraryItems: NavItem[] = [
  { id: 'history', label: 'History', icon: '🕐' },
  { id: 'liked', label: 'Liked videos', icon: '👍' },
  { id: 'playlists', label: 'Playlists', icon: '📁' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeItem,
  onNavigate,
  collapsed = false,
  identity,
  subscriptions = [],
  onSubscriptionClick,
}) => {
  const width = collapsed ? layout.sidebarCollapsedWidth : layout.sidebarWidth;

  return (
    <aside style={{
      width,
      height: '100%',
      position: 'relative',
      zIndex: 10,
      backgroundColor: colors.bg,
      borderRight: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flexShrink: 0,
      transition: 'width 0.2s ease',
    }}>
      {/* Main Navigation */}
      <nav style={{ padding: spacing.sm, flex: 1, overflowY: 'auto' }}>
        <Column gap={spacing.xs}>
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={activeItem === item.id}
              collapsed={collapsed}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </Column>

        <Divider style={{ margin: `${spacing.md}px 0` }} />

        {/* Your Channel */}
        {identity && (
          <>
            <NavButton
              item={{ id: 'channel', label: 'Your channel', icon: '📹' }}
              active={activeItem === 'channel'}
              collapsed={collapsed}
              onClick={() => onNavigate('channel')}
            />
            <NavButton
              item={{ id: 'studio', label: 'Studio', icon: '🎬' }}
              active={activeItem === 'studio'}
              collapsed={collapsed}
              onClick={() => onNavigate('studio')}
            />
            <Divider style={{ margin: `${spacing.md}px 0` }} />
          </>
        )}

        {/* Library */}
        {!collapsed && (
          <Text size="sm" weight="semibold" color="secondary" style={{
            padding: `${spacing.sm}px ${spacing.md}px`,
            display: 'block',
          }}>
            Library
          </Text>
        )}
        <Column gap={spacing.xs}>
          {libraryItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={activeItem === item.id}
              collapsed={collapsed}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </Column>

        {/* Subscriptions */}
        {subscriptions.length > 0 && (
          <>
            <Divider style={{ margin: `${spacing.md}px 0` }} />
            {!collapsed && (
              <Text size="sm" weight="semibold" color="secondary" style={{
                padding: `${spacing.sm}px ${spacing.md}px`,
                display: 'block',
              }}>
                Subscriptions
              </Text>
            )}
            <Column gap={spacing.xs}>
              {subscriptions.slice(0, 7).map((sub) => (
                <SubscriptionButton
                  key={sub.driveKey}
                  name={sub.name}
                  collapsed={collapsed}
                  onClick={() => onSubscriptionClick?.(sub.driveKey)}
                />
              ))}
              {subscriptions.length > 7 && !collapsed && (
                <NavButton
                  item={{ id: 'all-subs', label: `Show ${subscriptions.length - 7} more`, icon: '▼' }}
                  active={false}
                  collapsed={collapsed}
                  onClick={() => onNavigate('subscriptions')}
                />
              )}
            </Column>
          </>
        )}
      </nav>

      {/* Settings at bottom */}
      <div style={{ padding: spacing.sm, borderTop: `1px solid ${colors.border}` }}>
        <NavButton
          item={{ id: 'settings', label: 'Settings', icon: '⚙️' }}
          active={activeItem === 'settings'}
          collapsed={collapsed}
          onClick={() => onNavigate('settings')}
        />
      </div>
    </aside>
  );
};

// Nav Button Component
interface NavButtonProps {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}

const NavButton: React.FC<NavButtonProps> = ({ item, active, collapsed, onClick }) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        padding: collapsed ? spacing.md : `${spacing.sm}px ${spacing.md}px`,
        backgroundColor: active ? colors.bgActive : hovered ? colors.bgHover : 'transparent',
        border: 'none',
        borderRadius: radius.lg,
        cursor: 'pointer',
        justifyContent: collapsed ? 'center' : 'flex-start',
        transition: 'background-color 0.1s ease',
      }}
    >
      <span style={{ fontSize: 18 }}>{item.icon}</span>
      {!collapsed && (
        <Text
          size="sm"
          weight={active ? 'semibold' : 'normal'}
          color={active ? 'primary' : 'secondary'}
          truncate
        >
          {item.label}
        </Text>
      )}
      {!collapsed && item.badge !== undefined && item.badge > 0 && (
        <span style={{
          marginLeft: 'auto',
          backgroundColor: colors.primary,
          color: colors.textPrimary,
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: radius.full,
        }}>
          {item.badge}
        </span>
      )}
    </button>
  );
};

// Subscription Button Component
interface SubscriptionButtonProps {
  name: string;
  collapsed: boolean;
  onClick: () => void;
}

const SubscriptionButton: React.FC<SubscriptionButtonProps> = ({ name, collapsed, onClick }) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        padding: collapsed ? spacing.md : `${spacing.xs}px ${spacing.md}px`,
        backgroundColor: hovered ? colors.bgHover : 'transparent',
        border: 'none',
        borderRadius: radius.lg,
        cursor: 'pointer',
        justifyContent: collapsed ? 'center' : 'flex-start',
      }}
    >
      <Avatar name={name} size="xs" />
      {!collapsed && (
        <Text size="sm" color="secondary" truncate style={{ flex: 1 }}>
          {name}
        </Text>
      )}
    </button>
  );
};

export default Sidebar;
