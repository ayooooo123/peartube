import type { ComponentProps } from 'react'
import { useApp } from '@/lib/AppContext'
import CreatorPage from '../../components/routes/CreatorPage'

export default function CreatorRoute(props: ComponentProps<typeof CreatorPage>) {
  const { rpc } = useApp()
  return <CreatorPage {...props} mediaGraph={props.mediaGraph || rpc} />
}
