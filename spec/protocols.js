// PearTube's own Protomux protocols: each one's channel name and its ordered ops. An op's index in its list is the
// `op` of every frame for it (src/control-channel.js), so a list only grows at its end: never insert, reorder,
// rename or remove an entry. A request names its request and response structs, an event its one struct, all in
// spec/hyperschema (written by spec/build.mjs). The Rust port keeps the same tables and a fixture holds them equal.
// A struct with an array has it as its first field (after the flags word, if the struct has one), and its op says
// how many items the array may hold (`maxItems`) and whether a flags word comes first (`flags`): the envelope reads
// that count before it decodes or sends the value, so a peer cannot make it allocate for a count it never fills.

const request = (name, req, res, array = {}) => ({ name, kind: 'request', request: `@peartube/${req}`, response: `@peartube/${res}`, ...array })
const event = (name, struct, array = {}) => ({ name, kind: 'event', event: `@peartube/${struct}`, ...array })

const HITS = { maxItems: 20, flags: false }
const STATE = { maxItems: 128, flags: true }
const CARDS = { maxItems: 64, flags: false }

export const SEARCH = {
  protocol: 'peartube/search/v2',
  ops: [
    request('query', 'search-query', 'search-hits', HITS)
  ]
}

export const CAST = {
  protocol: 'peartube-cast/v2',
  ops: [
    request('pair', 'cast-pair', 'cast-paired'),
    request('subscribe', 'cast-subscribe', 'cast-state', STATE),
    request('command', 'cast-command', 'cast-state', STATE),
    event('state', 'cast-state', STATE)
  ]
}

export const GUARD = {
  protocol: 'peartube/private-guard/v2',
  ops: [
    request('hello', 'guard-hello', 'guard-ack'),
    request('register', 'guard-register', 'guard-ack'),
    request('putMutable', 'guard-put-mutable', 'guard-ack'),
    request('getMutable', 'guard-key', 'guard-get-result'),
    request('rvRegister', 'guard-rv-register', 'guard-ack'),
    event('rvUnregister', 'guard-rv-slot'),
    request('rvLookup', 'guard-key', 'guard-cards', CARDS),
    request('rvFetch', 'guard-key', 'guard-cards', CARDS),
    request('dialOpen', 'guard-dial', 'guard-ready'),
    request('hopOpen', 'guard-open', 'guard-ready'),
    request('incOpen', 'guard-open', 'guard-ready'),
    event('circuitDead', 'guard-circuit-dead')
  ]
}
