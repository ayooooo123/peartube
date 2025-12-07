/**
 * Settings Page - Profile & App Settings
 */

import React from 'react';
import { colors, spacing } from '../lib/theme';
import type { BackendStatus, Identity } from '@peartube/core';
import { Column, Row, Text, Button, Input, Card, Avatar, Divider, Alert } from '../components/ui';

interface SettingsPageProps {
  identity: Identity | null;
  status: BackendStatus | null;
  onLogout: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  identity,
  status,
  onLogout,
}) => {
  const [showLogoutConfirm, setShowLogoutConfirm] = React.useState(false);

  return (
    <Column style={{ padding: spacing.xl, maxWidth: 800, margin: '0 auto' }}>
      <Text size="xxl" weight="bold" style={{ marginBottom: spacing.xl }}>
        Settings
      </Text>

      {/* Profile Section */}
      <Card style={{ marginBottom: spacing.lg }}>
        <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
          Profile
        </Text>
        <Row gap={spacing.xl}>
          <Avatar name={identity?.name} size="xl" />
          <Column gap={spacing.md} style={{ flex: 1 }}>
            <div>
              <Text size="sm" color="secondary" style={{ marginBottom: spacing.xs, display: 'block' }}>
                Channel Name
              </Text>
              <Input defaultValue={identity?.name || ''} />
            </div>
            <Button variant="primary" style={{ alignSelf: 'flex-start' }}>
              Update Profile
            </Button>
          </Column>
        </Row>
      </Card>

      {/* Account Info */}
      <Card style={{ marginBottom: spacing.lg }}>
        <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
          Account Information
        </Text>
        <Column gap={spacing.md}>
          <Row justify="space-between">
            <Text color="secondary">Public Key</Text>
            <Text size="sm" style={{ fontFamily: 'monospace', maxWidth: 300 }}>
              {identity?.publicKey?.slice(0, 20)}...{identity?.publicKey?.slice(-8)}
            </Text>
          </Row>
          <Divider />
          <Row justify="space-between">
            <Text color="secondary">Drive Key</Text>
            <Text size="sm" style={{ fontFamily: 'monospace', maxWidth: 300 }}>
              {identity?.driveKey?.slice(0, 20)}...{identity?.driveKey?.slice(-8)}
            </Text>
          </Row>
          <Divider />
          <Row justify="space-between">
            <Text color="secondary">Created</Text>
            <Text size="sm">
              {identity?.createdAt ? new Date(identity.createdAt).toLocaleDateString() : 'Unknown'}
            </Text>
          </Row>
        </Column>
      </Card>

      {/* Network Status */}
      <Card style={{ marginBottom: spacing.lg }}>
        <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
          Network Status
        </Text>
        <Column gap={spacing.md}>
          <Row justify="space-between" align="center">
            <Text color="secondary">Connection Status</Text>
            <Row gap={spacing.sm} align="center">
              <div style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: status?.connected ? colors.success : colors.error,
              }} />
              <Text>{status?.connected ? 'Connected' : 'Disconnected'}</Text>
            </Row>
          </Row>
          <Divider />
          <Row justify="space-between">
            <Text color="secondary">Peers</Text>
            <Text>{status?.peers || 0}</Text>
          </Row>
          <Divider />
          <Row justify="space-between">
            <Text color="secondary">Version</Text>
            <Text>{status?.version || 'Unknown'}</Text>
          </Row>
        </Column>
      </Card>

      {/* Appearance */}
      <Card style={{ marginBottom: spacing.lg }}>
        <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
          Appearance
        </Text>
        <Column gap={spacing.md}>
          <Row justify="space-between" align="center">
            <Column gap={spacing.xs}>
              <Text>Dark Mode</Text>
              <Text size="sm" color="muted">Always enabled</Text>
            </Column>
            <div style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              backgroundColor: colors.primary,
              padding: 2,
              cursor: 'not-allowed',
              opacity: 0.6,
            }}>
              <div style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                backgroundColor: colors.textPrimary,
                marginLeft: 'auto',
              }} />
            </div>
          </Row>
        </Column>
      </Card>

      {/* Storage */}
      <Card style={{ marginBottom: spacing.lg }}>
        <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
          Storage
        </Text>
        <Column gap={spacing.md}>
          <Row justify="space-between" align="center">
            <Column gap={spacing.xs}>
              <Text>Clear Cache</Text>
              <Text size="sm" color="muted">Remove temporary files and cached data</Text>
            </Column>
            <Button variant="secondary" size="sm">Clear</Button>
          </Row>
        </Column>
      </Card>

      {/* Danger Zone */}
      <Card style={{
        border: `1px solid ${colors.error}`,
        backgroundColor: 'rgba(255, 0, 0, 0.05)',
      }}>
        <Text weight="semibold" color="error" style={{ marginBottom: spacing.lg }}>
          Danger Zone
        </Text>

        {showLogoutConfirm ? (
          <Alert variant="warning" style={{ marginBottom: spacing.md }}>
            <Column gap={spacing.sm}>
              <Text>Are you sure you want to log out?</Text>
              <Text size="sm" color="muted">
                Make sure you have saved your recovery phrase before logging out.
              </Text>
              <Row gap={spacing.sm} style={{ marginTop: spacing.sm }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLogoutConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onLogout}
                  style={{ backgroundColor: colors.error }}
                >
                  Yes, Log Out
                </Button>
              </Row>
            </Column>
          </Alert>
        ) : (
          <Row justify="space-between" align="center">
            <Column gap={spacing.xs}>
              <Text>Log Out</Text>
              <Text size="sm" color="muted">
                Sign out of your account on this device
              </Text>
            </Column>
            <Button
              variant="secondary"
              onClick={() => setShowLogoutConfirm(true)}
              style={{ borderColor: colors.error, color: colors.error }}
            >
              Log Out
            </Button>
          </Row>
        )}
      </Card>
    </Column>
  );
};

export default SettingsPage;
