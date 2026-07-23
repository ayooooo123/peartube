import type { ReactElement } from 'react'
import type { ListRenderItem } from 'react-native'
import { StyleSheet, View } from 'react-native'
import { Rail, SectionHeader } from '@/components/primitives'

export interface MediaRailProps<T> {
  title: string
  subtitle?: string
  data: T[]
  itemWidth: number
  renderItem: ListRenderItem<T>
  keyExtractor: (item: T, index: number) => string
  actionLabel?: string
  onActionPress?: () => void
  topSpacing?: number
}

export function MediaRail<T>({
  title,
  subtitle,
  data,
  itemWidth,
  renderItem,
  keyExtractor,
  actionLabel,
  onActionPress,
  topSpacing = 24,
}: MediaRailProps<T>): ReactElement | null {
  if (data.length === 0) return null

  const action = actionLabel && onActionPress ? { label: actionLabel, onPress: onActionPress } : undefined
  const testID = `media-rail-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`

  return (
    <View testID={testID} style={styles.container}>
      <SectionHeader title={title} subtitle={subtitle} action={action} style={[styles.header, { marginTop: topSpacing }]} />
      <Rail data={data} itemWidth={itemWidth} renderItem={renderItem} keyExtractor={keyExtractor} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  header: {
    marginBottom: 12,
  },
})
