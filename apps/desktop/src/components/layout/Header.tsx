/**
 * Header Component
 */

import React from 'react';
import { colors, spacing, layout } from '../../lib/theme';
import { Row, Text, Input, Button, Avatar, IconButton } from '../ui';

interface HeaderProps {
  onMenuClick: () => void;
  onSearch: (query: string) => void;
  identity?: { name?: string; publicKey: string };
  onUploadClick?: () => void;
  onProfileClick?: () => void;
  onCreateIdentity?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onMenuClick,
  onSearch,
  identity,
  onUploadClick,
  onProfileClick,
  onCreateIdentity,
}) => {
  const [searchQuery, setSearchQuery] = React.useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  return (
    <header style={{
      height: layout.headerHeight,
      backgroundColor: colors.bg,
      borderBottom: `1px solid ${colors.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${spacing.lg}px`,
      gap: spacing.lg,
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      {/* Left: Menu & Logo */}
      <Row gap={spacing.md} align="center">
        <IconButton
          icon="☰"
          onClick={onMenuClick}
          size="lg"
        />
        <Row gap={spacing.xs} align="center" style={{ cursor: 'pointer' }}>
          <span style={{ fontSize: 24 }}>🍐</span>
          <Text size="xl" weight="bold" style={{ letterSpacing: -0.5 }}>
            PearTube
          </Text>
        </Row>
      </Row>

      {/* Center: Search */}
      <form onSubmit={handleSearch} style={{
        flex: 1,
        maxWidth: 640,
        display: 'flex',
        justifyContent: 'center',
      }}>
        <Row style={{ width: '100%' }}>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            icon="🔍"
            style={{
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
              borderRight: 'none',
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            style={{
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              paddingLeft: spacing.lg,
              paddingRight: spacing.lg,
            }}
          >
            🔍
          </Button>
        </Row>
      </form>

      {/* Right: Actions */}
      <Row gap={spacing.sm} align="center">
        {identity ? (
          <>
            <Button
              variant="ghost"
              icon="📹"
              onClick={onUploadClick}
            >
              Upload
            </Button>
            <IconButton icon="🔔" size="lg" />
            <button
              onClick={onProfileClick}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <Avatar name={identity.name} size="sm" />
            </button>
          </>
        ) : (
          <Button variant="primary" onClick={onCreateIdentity}>
            Create Channel
          </Button>
        )}
      </Row>
    </header>
  );
};

export default Header;
