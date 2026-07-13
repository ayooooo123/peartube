# hyperdht-private-routes

An experimental private-route protocol scaffold for the Holepunch stack.

This package is a virtual protocol core only—no real network privacy yet. It is not wired into HyperDHT, Hyperswarm, UDX, PearTube, or any production network path.

## Status

Protocol version 0 is **EXPERIMENTAL**. It has no compatibility promise, has not received an external cryptographic audit, and remains `private: true` until the protocol and cryptography are independently reviewed.

This commit contains the package manifest, reproducible dependency lock, protocol RFC, and threat model only. It does not yet contain `index.js`, implementation modules, tests, or a fuzz harness. The package MUST NOT be imported or published until its export surface and tests land in subsequent implementation tasks.

The intended compiled route is:

```text
source -> guard -> safety relay(s) -> private entry -> private relay(s) -> destination
```

The source chooses the Safety Route and the destination chooses the Private Route. Relay roles are deterministically separated by identity. A failed private route never enables direct dialing or hole punching.

## Current scaffold commands

Run these from the repository root. Each command is scoped to `packages/private-routes` and does not install the repository root:

```bash
npm ci --prefix packages/private-routes
npm run format --prefix packages/private-routes
npm run format:check --prefix packages/private-routes
```

The manifest reserves the following commands for subsequent implementation tasks. They are forthcoming and are not runnable in this protocol-scaffold commit because their test and fuzz files do not exist yet:

```bash
npm test --prefix packages/private-routes
npm run test:node --prefix packages/private-routes
npm run test:bare --prefix packages/private-routes
npm run fuzz:cell --prefix packages/private-routes
```

## Security boundary

- The guard sees the source IP.
- The final private relay sees the destination IP.
- A DHT gateway sees DHT keys/topics, operation type, timing, and size.
- Separate identities controlled by one operator count as collusion/Sybil behavior.
- Global timing correlation, ordinary HTTP/HTTPS, DNS, and Tor-level anonymity are out of scope.
- Failure never enables direct dialing or hole punching.

See [docs/protocol.md](docs/protocol.md) for the normative experimental protocol and [docs/threat-model.md](docs/threat-model.md) for claims, observer visibility, and allowed flows.
