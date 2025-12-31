/**
 * Downloads Tab - View and manage video downloads
 */
import { View, Text, ScrollView, Pressable, Alert, Platform, Image } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useDownloads, DownloadItem, DownloadStatus } from '../../lib/DownloadsContext'
import { colors } from '../_layout'
import { CastHeaderButton } from '@/components/cast'

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// Status icon component
function StatusIcon({ status }: { status: DownloadStatus }) {
  switch (status) {
    case 'complete':
      return <Feather name="check-circle" size={20} color={colors.primary} />
    case 'error':
      return <Feather name="alert-circle" size={20} color="#ef4444" />
    case 'cancelled':
      return <Feather name="x" size={20} color={colors.textSecondary} />
    case 'queued':
      return <Feather name="clock" size={20} color={colors.textSecondary} />
    default:
      return <Feather name="download" size={20} color={colors.primary} />
  }
}

// Progress bar component
function ProgressBar({ progress }: { progress: number }) {
  return (
    <View style={{
      height: 4,
      backgroundColor: colors.surface,
      borderRadius: 2,
      overflow: 'hidden',
      marginTop: 8
    }}>
      <View style={{
        height: '100%',
        width: `${Math.min(100, progress)}%`,
        backgroundColor: colors.primary,
        borderRadius: 2
      }} />
    </View>
  )
}

// Individual download item component
function DownloadItemRow({
  item,
  onCancel,
  onRemove,
  onRetry
}: {
  item: DownloadItem
  onCancel: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  const isActive = item.status === 'downloading' || item.status === 'queued' || item.status === 'saving'
  const isComplete = item.status === 'complete'
  const isError = item.status === 'error'

  return (
    <View style={{
      flexDirection: 'row',
      padding: 12,
      backgroundColor: colors.bgCard,
      borderRadius: 12,
      marginBottom: 8,
      alignItems: 'center'
    }}>
      {/* Thumbnail */}
      <View style={{
        width: 80,
        height: 45,
        borderRadius: 6,
        backgroundColor: colors.surface,
        overflow: 'hidden',
        marginRight: 12
      }}>
        {item.thumbnail ? (
          <Image
            source={{ uri: item.thumbnail }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Feather name="download" size={20} color={colors.textSecondary} />
          </View>
        )}
      </View>

      {/* Info */}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: colors.text,
            fontSize: 14,
            fontWeight: '500'
          }}
          numberOfLines={1}
        >
          {item.title}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
          <StatusIcon status={item.status} />
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginLeft: 6 }}>
            {item.status === 'downloading' && `${item.progress}% · ${item.speed}`}
            {item.status === 'saving' && 'Saving to gallery...'}
            {item.status === 'queued' && 'Waiting...'}
            {item.status === 'complete' && `${formatBytes(item.totalBytes)} · Saved`}
            {item.status === 'error' && (item.error || 'Failed')}
            {item.status === 'cancelled' && 'Cancelled'}
          </Text>
        </View>

        {/* Progress bar for active downloads */}
        {isActive && <ProgressBar progress={item.progress} />}
      </View>

      {/* Action button */}
      <Pressable
        onPress={() => {
          if (isActive) {
            onCancel()
          } else if (isError) {
            onRetry()
          } else {
            onRemove()
          }
        }}
        style={{
          padding: 8,
          marginLeft: 8
        }}
      >
        {isActive ? (
          <Feather name="x" size={20} color={colors.textSecondary} />
        ) : isError ? (
          <Feather name="refresh-cw" size={20} color={colors.primary} />
        ) : (
          <Feather name="trash-2" size={18} color={colors.textSecondary} />
        )}
      </Pressable>
    </View>
  )
}

export default function DownloadsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { downloads, activeCount, cancelDownload, removeDownload, clearCompleted, retryDownload } = useDownloads()

  // We need rpc for retry - get it from app context
  // For now, retry won't work without passing rpc through
  // This will be fixed when we update VideoPlayerOverlay

  const hasCompleted = downloads.some(d => d.status === 'complete' || d.status === 'cancelled' || d.status === 'error')

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + 16,
        paddingHorizontal: 20,
        paddingBottom: 16,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Feather name="download" size={24} color={colors.primary} />
          <Text style={{
            color: colors.text,
            fontSize: 24,
            fontWeight: 'bold',
            marginLeft: 12
          }}>
            Downloads
          </Text>
          {activeCount > 0 && (
            <View style={{
              backgroundColor: colors.primary,
              borderRadius: 12,
              paddingHorizontal: 8,
              paddingVertical: 2,
              marginLeft: 8
            }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                {activeCount}
              </Text>
            </View>
          )}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <CastHeaderButton size={18} color={colors.textSecondary} activeColor={colors.primary} />
          <Pressable onPress={() => router.push('/search')} style={{ padding: 8 }}>
            <Feather name="search" size={18} color={colors.textSecondary} />
          </Pressable>
          {hasCompleted && (
            <Pressable
              onPress={clearCompleted}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 8
              }}
            >
              <Feather name="trash-2" size={18} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, fontSize: 14, marginLeft: 4 }}>
                Clear
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 100
        }}
      >
        {downloads.length === 0 ? (
          <View style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingTop: 100
          }}>
            <Feather name="folder" size={64} color={colors.textSecondary} />
            <Text style={{
              color: colors.textSecondary,
              fontSize: 18,
              marginTop: 16,
              textAlign: 'center'
            }}>
              No downloads yet
            </Text>
            <Text style={{
              color: colors.textSecondary,
              fontSize: 14,
              marginTop: 8,
              textAlign: 'center',
              paddingHorizontal: 40
            }}>
              Videos you download will appear here
            </Text>
          </View>
        ) : (
          <>
            {/* Active downloads */}
            {downloads.filter(d => d.status === 'downloading' || d.status === 'queued' || d.status === 'saving').length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <Text style={{
                  color: colors.textSecondary,
                  fontSize: 12,
                  fontWeight: '600',
                  marginBottom: 8,
                  textTransform: 'uppercase'
                }}>
                  Active
                </Text>
                {downloads
                  .filter(d => d.status === 'downloading' || d.status === 'queued' || d.status === 'saving')
                  .map(item => (
                    <DownloadItemRow
                      key={item.id}
                      item={item}
                      onCancel={() => cancelDownload(item.id)}
                      onRemove={() => removeDownload(item.id)}
                      onRetry={() => {
                        Alert.alert('Retry', 'Please retry from the video player')
                      }}
                    />
                  ))
                }
              </View>
            )}

            {/* Completed downloads */}
            {downloads.filter(d => d.status === 'complete').length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <Text style={{
                  color: colors.textSecondary,
                  fontSize: 12,
                  fontWeight: '600',
                  marginBottom: 8,
                  textTransform: 'uppercase'
                }}>
                  Completed
                </Text>
                {downloads
                  .filter(d => d.status === 'complete')
                  .map(item => (
                    <DownloadItemRow
                      key={item.id}
                      item={item}
                      onCancel={() => cancelDownload(item.id)}
                      onRemove={() => removeDownload(item.id)}
                      onRetry={() => {}}
                    />
                  ))
                }
              </View>
            )}

            {/* Failed/Cancelled */}
            {downloads.filter(d => d.status === 'error' || d.status === 'cancelled').length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <Text style={{
                  color: colors.textSecondary,
                  fontSize: 12,
                  fontWeight: '600',
                  marginBottom: 8,
                  textTransform: 'uppercase'
                }}>
                  Failed
                </Text>
                {downloads
                  .filter(d => d.status === 'error' || d.status === 'cancelled')
                  .map(item => (
                    <DownloadItemRow
                      key={item.id}
                      item={item}
                      onCancel={() => cancelDownload(item.id)}
                      onRemove={() => removeDownload(item.id)}
                      onRetry={() => {
                        Alert.alert('Retry', 'Please retry from the video player')
                      }}
                    />
                  ))
                }
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  )
}
