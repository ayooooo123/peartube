import { useEffect, useState } from 'react'

type Loader<T> = (input: { rpc: any; entityId: string }) => Promise<T>

type RouteEntityState<T> = {
  item: T | null
  error: string | null
  loading: boolean
}

export function firstRouteParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function useRouteEntityLoader<T>({
  entityId,
  explicitItem,
  rpc,
  loader,
}: {
  entityId?: string
  explicitItem?: T | null
  rpc?: any
  loader: Loader<T>
}): RouteEntityState<T> {
  const [state, setState] = useState<RouteEntityState<T>>({ item: null, error: null, loading: false })

  useEffect(() => {
    if (explicitItem || !entityId || !rpc) {
      setState({ item: null, error: null, loading: false })
      return
    }

    let active = true
    setState({ item: null, error: null, loading: true })
    void loader({ rpc, entityId }).then(
      item => {
        if (active) setState({ item, error: null, loading: false })
      },
      error => {
        if (active) setState({ item: null, error: error?.message || String(error), loading: false })
      },
    )

    return () => {
      active = false
    }
  }, [entityId, explicitItem, loader, rpc])

  if (explicitItem) return { item: explicitItem, error: null, loading: false }
  return state
}
