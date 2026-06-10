import { ReactElement } from 'react'
import { FlatList, ListRenderItem, StyleProp, ViewStyle } from 'react-native'

interface RailProps<T> {
  data: T[]
  renderItem: ListRenderItem<T>
  keyExtractor: (item: T, index: number) => string
  /** Item width incl. nothing — used for snap intervals. */
  itemWidth: number
  gap?: number
  style?: StyleProp<ViewStyle>
}

/**
 * Horizontal snap carousel used for Continue Watching / Recommended rails.
 */
export function Rail<T>({
  data,
  renderItem,
  keyExtractor,
  itemWidth,
  gap = 12,
  style,
}: RailProps<T>): ReactElement {
  return (
    <FlatList
      horizontal
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      snapToInterval={itemWidth + gap}
      snapToAlignment="start"
      decelerationRate="fast"
      contentContainerStyle={{ paddingHorizontal: 16, gap }}
      style={style}
    />
  )
}
