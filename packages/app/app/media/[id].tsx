import type { ComponentProps } from 'react'
import { useApp } from '@/lib/AppContext'
import MediaEntityPage, { normalizeMediaEntityView } from '../../components/routes/MediaEntityPage'
import type { MediaEntityView } from '../../components/routes/MediaEntityPage'

export { normalizeMediaEntityView }
export type { MediaEntityView }

export default function MediaRoute(props: ComponentProps<typeof MediaEntityPage>) {
  const { rpc } = useApp()
  return <MediaEntityPage {...props} mediaGraph={props.mediaGraph || rpc} />
}
