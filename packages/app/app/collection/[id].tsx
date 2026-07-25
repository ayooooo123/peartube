import type { ComponentProps } from 'react'
import { useApp } from '@/lib/AppContext'
import CollectionPage from '../../components/routes/CollectionPage'

export default function CollectionRoute(props: ComponentProps<typeof CollectionPage>) {
  const { rpc } = useApp()
  return <CollectionPage {...props} mediaGraph={props.mediaGraph || rpc} />
}
