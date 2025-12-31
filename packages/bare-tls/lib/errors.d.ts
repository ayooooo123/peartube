declare class TLSError extends Error {
  static from(err: Error): TLSError
}

export = TLSError
