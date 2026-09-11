import { useState, type ReactNode } from 'react'
import {
  Modal,
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  type TextInputProps,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { useApp } from '@/lib/AppContext'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import {
  Button,
  Chip,
  Divider,
  Eyebrow,
  IconButton,
  Meta,
} from '@/components/primitives'

const CATEGORIES = ['Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']

interface VideoEditModalProps {
  visible: boolean
  video: any
  channelKey: string
  onClose: () => void
  onSaved: () => void
}

export function VideoEditModal({ visible, video, channelKey, onClose, onSaved }: VideoEditModalProps) {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.scrim}>
        <VideoEditModalForm
          key={video?.id ?? 'empty'}
          video={video}
          channelKey={channelKey}
          onClose={onClose}
          onSaved={onSaved}
        />
      </View>
    </Modal>
  )
}

function VideoEditModalForm({ video, channelKey, onClose, onSaved }: Omit<VideoEditModalProps, 'visible'>) {
  const { rpc } = useApp()
  const [title, setTitle] = useState(video?.title || '')
  const [description, setDescription] = useState(video?.description || '')
  const [category, setCategory] = useState(video?.category || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titleFocused, setTitleFocused] = useState(false)
  const [descriptionFocused, setDescriptionFocused] = useState(false)

  const handleChangeThumbnail = async () => {
    if (!video?.id) {
      setError('Missing video id')
      return
    }

    try {
      setError(null)
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
      })

      if (result.canceled || !result.assets?.[0]) return

      const asset = result.assets[0]
      if (!asset.uri) {
        setError('Unable to read image path')
        return
      }

      const thumbRes = await (rpc as any).setVideoThumbnailFromFile({
        videoId: video.id,
        filePath: asset.uri,
      })

      if (!thumbRes?.success) {
        setError(thumbRes?.error || 'Failed to update thumbnail')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to update thumbnail')
    }
  }

  const handleSave = async () => {
    if (!rpc || !video?.id || !channelKey) {
      setError('Missing required data to save changes')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const result = await (rpc as any).updateVideoMetadata({
        channelKey,
        videoId: video.id,
        title,
        description,
        category,
      })

      if (!result?.success) {
        setError(result?.error || 'Failed to save video changes')
        return
      }

      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Failed to save video changes')
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>EDIT</Text>
        <IconButton icon="x" accessibilityLabel="Close" onPress={onClose} variant="plain" size={36} />
      </View>
      <Divider weight="rule" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="TITLE">
          <EditInput
            placeholder="Video title"
            value={title}
            onChangeText={setTitle}
            focused={titleFocused}
            onFocus={() => setTitleFocused(true)}
            onBlur={() => setTitleFocused(false)}
          />
        </Field>

        <Field label="DESCRIPTION">
          <EditInput
            placeholder="Describe your video"
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            focused={descriptionFocused}
            onFocus={() => setDescriptionFocused(true)}
            onBlur={() => setDescriptionFocused(false)}
            style={styles.multiline}
          />
        </Field>

        <Field label="CATEGORY">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {CATEGORIES.map((item) => (
                <Chip
                  key={item}
                  label={item}
                  selected={category === item}
                  onPress={() => setCategory(item)}
                />
              ))}
            </View>
          </ScrollView>
        </Field>

        <Field label="THUMBNAIL">
          <Button
            label="CHANGE THUMBNAIL"
            variant="secondary"
            icon="image"
            onPress={handleChangeThumbnail}
            block
          />
        </Field>

        {error ? <Meta tone="danger">{error}</Meta> : null}
      </ScrollView>

      <Divider weight="rule" />
      <View style={styles.footer}>
        <Button
          label="CANCEL"
          variant="ghost"
          onPress={onClose}
          disabled={saving}
          style={styles.footerBtn}
        />
        <Button
          label="SAVE"
          variant="primary"
          onPress={handleSave}
          disabled={saving}
          loading={saving}
          style={styles.footerBtn}
        />
      </View>
    </View>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Eyebrow style={styles.fieldLabel}>{label}</Eyebrow>
      {children}
    </View>
  )
}

function EditInput({
  focused,
  style,
  ...props
}: TextInputProps & { focused?: boolean }) {
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      {...props}
      style={[styles.input, focused && styles.inputFocused, style]}
    />
  )
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.scrim,
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopWidth: borderWidth.rule,
    borderLeftWidth: borderWidth.rule,
    borderRightWidth: borderWidth.rule,
    borderColor: colors.border,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    minHeight: 56,
  },
  headerTitle: {
    ...fonts.title.lg,
    color: colors.text,
    flex: 1,
  },
  scroll: {
    maxHeight: 560,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.lg,
  },
  field: {
    gap: spacing.sm,
  },
  fieldLabel: {
    marginBottom: 0,
  },
  input: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text,
    ...fonts.body.md,
  },
  inputFocused: {
    borderColor: colors.borderFocus,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.xs,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  footerBtn: {
    flex: 1,
  },
})

export default VideoEditModal
