/**
 * Studio Page - Channel Management & Upload
 */

import React from 'react';
import { colors, spacing, radius } from '../lib/theme';
import { rpc } from '../lib/rpc';
import type { Video, Channel } from '@peartube/shared';
import desktopAdapter from '../platform/desktopAdapter';
import { Column, Row, Text, Button, Input, TextArea, Card, Tabs, Avatar, Alert } from '../components/ui';
import { VideoCard } from '../components/VideoCard';

interface StudioPageProps {
  identity: { name?: string; publicKey: string; driveKey?: string };
  onVideoClick: (video: Video) => void;
}

export const StudioPage: React.FC<StudioPageProps> = ({
  identity,
  onVideoClick,
}) => {
  const [activeTab, setActiveTab] = React.useState('content');
  const [videos, setVideos] = React.useState<Video[]>([]);
  const [channel, setChannel] = React.useState<Channel | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Upload state
  const [showUpload, setShowUpload] = React.useState(false);
  const [uploadTitle, setUploadTitle] = React.useState('');
  const [uploadDescription, setUploadDescription] = React.useState('');
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    loadData();
  }, [identity.driveKey]);

  async function loadData() {
    if (!identity.driveKey) return;
    try {
      setLoading(true);
      const [channelData, videosData] = await Promise.all([
        rpc.getChannel(identity.driveKey),
        rpc.listVideos(identity.driveKey),
      ]);
      setChannel(channelData);
      setVideos(videosData);
    } catch (err) {
      console.error('Failed to load studio data:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setUploadError('Please select a video file');
      return;
    }
    setUploadFile(file);
    setUploadError(null);
    if (!uploadTitle) {
      setUploadTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleChooseFile = async () => {
    const file = await desktopAdapter.pickVideoFile();
    handleFile(file);
  };

  // Upload progress state
  const [uploadProgress, setUploadProgress] = React.useState(0);

  const handleUpload = async () => {
    if (!uploadFile || !uploadTitle.trim()) {
      setUploadError('Please select a file and enter a title');
      return;
    }

    const filePath = (uploadFile as any).path as string | undefined;
    if (!filePath) {
      setUploadError('File path is unavailable. Please select a file from disk (desktop only).');
      return;
    }

    try {
      setUploading(true);
      setUploadError(null);
      setUploadProgress(0);

      console.log('[Upload] Starting upload for:', uploadFile.name, 'Size:', uploadFile.size, 'Path:', filePath);

      // Use file-path based upload via worker
      const result = await rpc.uploadVideo(
        uploadTitle.trim(),
        uploadDescription.trim(),
        filePath,
        uploadFile.type
      );

      if (result.success) {
        setUploadProgress(100);
        setVideos([result.metadata, ...videos]);
        setShowUpload(false);
        setUploadTitle('');
        setUploadDescription('');
        setUploadFile(null);
      }
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload');
    } finally {
      setUploading(false);
    }
  };

  const tabs = [
    { id: 'content', label: 'Content' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'customize', label: 'Customization' },
  ];

  return (
    <Column style={{ height: '100%' }}>
      {/* Header */}
      <Row
        justify="space-between"
        align="center"
        style={{
          padding: spacing.xl,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <Column gap={spacing.xs}>
          <Text size="xxl" weight="bold">Channel Studio</Text>
          <Text color="secondary">{channel?.name || identity.name || 'Your Channel'}</Text>
        </Column>
        <Button variant="primary" icon="📹" onClick={() => setShowUpload(true)}>
          Upload Video
        </Button>
      </Row>

      {/* Tabs */}
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
        style={{ padding: `0 ${spacing.xl}px` }}
      />

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: spacing.xl }}>
        {/* Upload Modal */}
        {showUpload && (
          <Card style={{ marginBottom: spacing.xl }}>
            <Row justify="space-between" align="center" style={{ marginBottom: spacing.lg }}>
              <Text size="lg" weight="semibold">Upload Video</Text>
              <Button variant="ghost" onClick={() => setShowUpload(false)}>Cancel</Button>
            </Row>

            {uploadError && (
              <Alert variant="error" onClose={() => setUploadError(null)} style={{ marginBottom: spacing.md }}>
                {uploadError}
              </Alert>
            )}

            <Column gap={spacing.md}>
              {/* File Drop Zone */}
              <div
                onClick={handleChooseFile}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFile(e.dataTransfer.files[0]);
                }}
                onDragOver={(e) => e.preventDefault()}
                style={{
                  border: `2px dashed ${uploadFile ? colors.primary : colors.border}`,
                  borderRadius: radius.lg,
                  padding: spacing.xxl,
                  textAlign: 'center',
                  cursor: 'pointer',
                  backgroundColor: uploadFile ? colors.primaryLight : colors.bgElevated,
                }}
              >
                {uploadFile ? (
                  <Column gap={spacing.sm} align="center">
                    <Text size="xl">📹</Text>
                    <Text weight="medium">{uploadFile.name}</Text>
                    <Text size="sm" color="muted">
                      {(uploadFile.size / (1024 * 1024)).toFixed(2)} MB
                    </Text>
                  </Column>
                ) : (
                  <Column gap={spacing.sm} align="center">
                    <Text size="xxl">📤</Text>
                    <Text weight="medium">Drag and drop video files to upload</Text>
                    <Text size="sm" color="muted">or click to select files</Text>
                  </Column>
                )}
              </div>

              <Input
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Video title"
              />

              <TextArea
                value={uploadDescription}
                onChange={(e) => setUploadDescription(e.target.value)}
                placeholder="Description (optional)"
              />

              <Row justify="flex-end" gap={spacing.sm}>
                <Button variant="ghost" onClick={() => setShowUpload(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={uploading}
                  disabled={!uploadFile || !uploadTitle.trim()}
                  onClick={handleUpload}
                >
                  Upload
                </Button>
              </Row>
            </Column>
          </Card>
        )}

        {/* Tab Content */}
        {activeTab === 'content' && (
          <Column gap={spacing.lg}>
            <Row justify="space-between" align="center">
              <Text weight="semibold">Channel Videos ({videos.length})</Text>
              <Input
                placeholder="Search videos..."
                icon="🔍"
                style={{ width: 300 }}
              />
            </Row>

            {loading ? (
              <Column align="center" style={{ padding: spacing.xxxl }}>
                <div style={{
                  width: 40,
                  height: 40,
                  border: `3px solid ${colors.border}`,
                  borderTopColor: colors.primary,
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
              </Column>
            ) : videos.length === 0 ? (
              <Card style={{ textAlign: 'center', padding: spacing.xxxl }}>
                <Text size="xxl">📺</Text>
                <Text size="lg" weight="semibold" style={{ marginTop: spacing.md }}>
                  No videos yet
                </Text>
                <Text color="muted" style={{ margin: `${spacing.sm}px 0 ${spacing.lg}px` }}>
                  Upload your first video to get started
                </Text>
                <Button variant="primary" onClick={() => setShowUpload(true)}>
                  Upload Video
                </Button>
              </Card>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: spacing.lg,
              }}>
                {videos.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    onClick={() => onVideoClick(video)}
                    variant="grid"
                  />
                ))}
              </div>
            )}
          </Column>
        )}

        {activeTab === 'analytics' && (
          <Card style={{ textAlign: 'center', padding: spacing.xxxl }}>
            <Text size="xxl">📊</Text>
            <Text size="lg" weight="semibold" style={{ marginTop: spacing.md }}>
              Analytics Coming Soon
            </Text>
            <Text color="muted" style={{ marginTop: spacing.sm }}>
              View counts, watch time, and audience insights
            </Text>
          </Card>
        )}

        {activeTab === 'customize' && (
          <Column gap={spacing.lg}>
            <Card>
              <Text weight="semibold" style={{ marginBottom: spacing.lg }}>Channel Profile</Text>
              <Row gap={spacing.xl}>
                <Avatar name={channel?.name} size="xl" />
                <Column gap={spacing.md} style={{ flex: 1 }}>
                  <div>
                    <Text size="sm" color="secondary" style={{ marginBottom: spacing.xs, display: 'block' }}>
                      Channel Name
                    </Text>
                    <Input defaultValue={channel?.name || ''} />
                  </div>
                  <div>
                    <Text size="sm" color="secondary" style={{ marginBottom: spacing.xs, display: 'block' }}>
                      Description
                    </Text>
                    <TextArea
                      defaultValue={channel?.description || ''}
                      placeholder="Tell viewers about your channel"
                    />
                  </div>
                </Column>
              </Row>
              <Row justify="flex-end" style={{ marginTop: spacing.lg }}>
                <Button variant="primary">Save Changes</Button>
              </Row>
            </Card>

            <Card>
              <Text weight="semibold" style={{ marginBottom: spacing.md }}>Channel Info</Text>
              <Column gap={spacing.sm}>
                <Row justify="space-between">
                  <Text color="secondary">Drive Key</Text>
                  <Text size="sm" style={{ fontFamily: 'monospace' }}>
                    {identity.driveKey?.slice(0, 16)}...
                  </Text>
                </Row>
                <Row justify="space-between">
                  <Text color="secondary">Public Key</Text>
                  <Text size="sm" style={{ fontFamily: 'monospace' }}>
                    {identity.publicKey.slice(0, 16)}...
                  </Text>
                </Row>
              </Column>
            </Card>
          </Column>
        )}
      </div>
    </Column>
  );
};

export default StudioPage;
