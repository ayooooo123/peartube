/**
 * useMiniPlayerPosition - Desktop mini player corner snapping
 *
 * Manages the draggable mini player position on desktop,
 * with corner snapping when the user releases the drag.
 */

import { useState, useRef, useCallback } from 'react'
import { DESKTOP_MINI_WIDTH, DESKTOP_MINI_HEIGHT, DESKTOP_MINI_PADDING, DESKTOP_MINI_CONTROLS_HEIGHT } from '../constants'

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

interface UseMiniPlayerPositionProps {
  screenWidth: number
  screenHeight: number
  sidebarWidth: number
}

interface DragStartRef {
  x: number
  y: number
  cornerX: number
  cornerY: number
}

export function useMiniPlayerPosition({
  screenWidth,
  screenHeight,
  sidebarWidth,
}: UseMiniPlayerPositionProps) {
  const [corner, setCorner] = useState<Corner>('bottom-right')
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const dragStartRef = useRef<DragStartRef>({ x: 0, y: 0, cornerX: 0, cornerY: 0 })

  // Calculate position based on corner
  const getPosition = useCallback(() => {
    const baseX = corner.includes('right')
      ? screenWidth - DESKTOP_MINI_WIDTH - DESKTOP_MINI_PADDING - sidebarWidth
      : DESKTOP_MINI_PADDING
    const baseY = corner.includes('bottom')
      ? screenHeight - DESKTOP_MINI_HEIGHT - DESKTOP_MINI_CONTROLS_HEIGHT - DESKTOP_MINI_PADDING - 108
      : DESKTOP_MINI_PADDING + 108

    if (isDragging) {
      return {
        x: baseX + dragOffset.x,
        y: baseY + dragOffset.y,
      }
    }
    return { x: baseX, y: baseY }
  }, [corner, screenWidth, screenHeight, sidebarWidth, isDragging, dragOffset])

  // Start dragging
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const pos = getPosition()
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      cornerX: pos.x,
      cornerY: pos.y,
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - dragStartRef.current.x
      const deltaY = moveEvent.clientY - dragStartRef.current.y
      setDragOffset({ x: deltaX, y: deltaY })
    }

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      const finalX = dragStartRef.current.cornerX + (upEvent.clientX - dragStartRef.current.x)
      const finalY = dragStartRef.current.cornerY + (upEvent.clientY - dragStartRef.current.y)

      const centerX = finalX + DESKTOP_MINI_WIDTH / 2
      const centerY = finalY + (DESKTOP_MINI_HEIGHT + DESKTOP_MINI_CONTROLS_HEIGHT) / 2
      const screenCenterX = (screenWidth - sidebarWidth) / 2 + sidebarWidth
      const screenCenterY = screenHeight / 2

      const isRight = centerX > screenCenterX
      const isBottom = centerY > screenCenterY

      const newCorner = `${isBottom ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as Corner
      setCorner(newCorner)
      setDragOffset({ x: 0, y: 0 })
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [getPosition, screenWidth, screenHeight, sidebarWidth])

  return {
    position: getPosition(),
    isDragging,
    handleDragStart,
    corner,
    setCorner,
  }
}
