declare module '@peartube/protocol' {
  export function createProtocolClient(options: any): any
  export const PROTOCOL_EVENTS: any
}

declare module '@peartube/protocol/events' {
  export const PROTOCOL_EVENTS: any
}

declare module '@peartube/spec/app-rpc-adapter' {
  export const RUNTIME_ONLY_METHODS: readonly string[]
}
