import { ReactElement, useCallback } from 'react'
import { FlatList, ListRenderItem, StyleProp, View, ViewStyle } from 'react-native'

interface RailProps<T> {
  data: T[]
  renderItem: ListRenderItem<T>
  keyExtractor: (item: T, index: number) => string
  /** Item width incl. nothing — used for snap intervals. */
  itemWidth: number
  /** Track height. Without it the carousel grows to whatever space is left. */
  itemHeight?: number
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
  itemHeight,
  gap = 12,
  style,
}: RailProps<T>): ReactElement {
  // A cell that only inherits its width from the card inside it will stretch to
  // the viewport whenever that card's own width does not resolve, turning a
  // shelf of posters into one full-bleed block. The carousel owns the track, so
  // it pins every cell to the width it is snapping against.
  const renderCell = useCallback<ListRenderItem<T>>((info) => (
    <View style={{ width: itemWidth, flexShrink: 0 }}>
      {renderItem(info)}
    </View>
  ), [itemWidth, renderItem])

  return (
    <FlatList
      horizontal
      data={data}
      renderItem={renderCell}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      snapToInterval={itemWidth + gap}
      snapToAlignment="start"
      decelerationRate="fast"
      contentContainerStyle={{ paddingHorizontal: 16, gap }}
      style={[itemHeight ? { height: itemHeight, flexGrow: 0 } : null, style]}
    />
  )
}
