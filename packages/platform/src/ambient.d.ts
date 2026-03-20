declare module 'react-native' {
  export const Platform: {
    OS?: string
    select?<T>(config: Record<string, T>): T
  }
}

declare module 'bare-storage' {
  export function persistent(): string
}
