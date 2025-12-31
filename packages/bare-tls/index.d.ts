import { Duplex, DuplexEvents } from 'bare-stream'
import constants from './lib/constants'
import TLSError from './lib/errors'

export { constants, TLSError as errors }

export interface TLSSocketEvents extends DuplexEvents {
  connect: []
}

export interface TLSSocketOptions {
  allowHalfOpen?: boolean
  cert?: ArrayBufferView
  eagerOpen?: boolean
  host?: string
  isServer?: boolean
  key?: ArrayBufferView
}

export interface TLSSocket<M extends TLSSocketEvents = TLSSocketEvents>
  extends Duplex<M> {
  readonly socket: Duplex
  readonly encrypted: true
}

export class TLSSocket {
  constructor(socket: Duplex, opts?: TLSSocketOptions)
}

export { TLSSocket as Socket }
