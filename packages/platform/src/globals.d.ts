export {}

declare global {
  // Pear runtime globals (desktop)
  var Pear:
    | {
        config?: {
          storage?: string
        }
      }
    | undefined

  // Bare runtime globals (mobile/backend)
  var Bare:
    | {
        argv?: unknown[]
      }
    | undefined
}
