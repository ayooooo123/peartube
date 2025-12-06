/**
 * Main App Layout - Sidebar + Header + Content
 */

import React from 'react';
import { colors } from '../../lib/theme';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

const PEAR_BAR_HEIGHT = 52; // height of injected Pear bar

interface AppLayoutProps {
  children: React.ReactNode;
  activeNav: string;
  onNavigate: (id: string) => void;
  onSearch: (query: string) => void;
  identity?: { name?: string; publicKey: string; driveKey?: string };
  subscriptions?: { driveKey: string; name: string }[];
  onUploadClick?: () => void;
  onProfileClick?: () => void;
  onCreateIdentity?: () => void;
  onSubscriptionClick?: (driveKey: string) => void;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  children,
  activeNav,
  onNavigate,
  onSearch,
  identity,
  subscriptions = [],
  onUploadClick,
  onProfileClick,
  onCreateIdentity,
  onSubscriptionClick,
}) => {
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      paddingTop: PEAR_BAR_HEIGHT,
      backgroundColor: colors.bg,
      color: colors.textPrimary,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <Header
        onMenuClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSearch={onSearch}
        identity={identity}
        onUploadClick={onUploadClick}
        onProfileClick={onProfileClick}
        onCreateIdentity={onCreateIdentity}
      />

      {/* Main Content Area */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
      }}>
        {/* Sidebar */}
        <Sidebar
          activeItem={activeNav}
          onNavigate={onNavigate}
          collapsed={sidebarCollapsed}
          identity={identity}
          subscriptions={subscriptions}
          onSubscriptionClick={onSubscriptionClick}
        />

        {/* Content */}
        <main style={{
          flex: 1,
          overflow: 'auto',
          padding: 0,
        }}>
          {children}
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
