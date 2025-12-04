# PearTube

A decentralized P2P video streaming platform built on the Pear runtime and Hypercore Protocol.

## Features (Planned)

- **Decentralized**: No central servers, pure P2P architecture
- **Self-sovereign**: Creators own their channels via cryptographic keypairs
- **Scalable**: Popular content automatically gets more seeders
- **Efficient**: Sparse replication and adaptive streaming
- **Censorship-resistant**: No single point of control

## Architecture

PearTube is built with a two-tier architecture:

- **Frontend**: React-based UI for browsing, watching, and uploading videos
- **Backend Worker**: Core P2P engine handling networking, storage, and video delivery

### Tech Stack

- **Pear Runtime**: Desktop application framework
- **Hyperswarm**: P2P networking and peer discovery
- **Hyperdrive**: Distributed file system for video storage
- **Hyperbee**: Key-value database for metadata
- **Autobase**: Multi-writer coordination for discovery
- **React**: Frontend UI framework

## Development

### Prerequisites

- Node.js 18+
- Pear CLI (`npm install -g pear`)

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run type checking
npm run typecheck

# Run linter
npm run lint
```

### Project Structure

```
peartube/
├── src/                  # Frontend source code
│   ├── index.tsx        # Entry point
│   ├── App.tsx          # Main app component
│   └── ...
├── workers/
│   └── core/            # Backend P2P worker
│       └── index.ts
├── build/               # Compiled output
├── storage/             # P2P data storage (gitignored)
└── package.json
```

## Development Roadmap

### Phase 1: Foundation (Current)
- [x] Project structure
- [ ] Basic Pear app setup
- [ ] Identity management
- [ ] Core backend worker
- [ ] RPC communication

### Phase 2: Channel & Upload
- [ ] Channel creation
- [ ] Video upload
- [ ] Transcoding pipeline
- [ ] Metadata management

### Phase 3: Playback & Discovery
- [ ] Video player
- [ ] P2P chunk loading
- [ ] Search & discovery
- [ ] Subscriptions

### Phase 4: Social Features
- [ ] Comments
- [ ] Likes/reactions
- [ ] Notifications
- [ ] Playlists

### Phase 5: Performance
- [ ] Bandwidth optimization
- [ ] Storage management
- [ ] Caching strategies

### Phase 6: Advanced
- [ ] Live streaming
- [ ] Monetization
- [ ] Content moderation tools

## How It Works

### Video Storage
- Each channel has a **Hyperdrive** for storing video files
- Videos are transcoded to HLS format with multiple qualities
- Short segments (2-6 seconds) for smooth streaming
- Sparse replication: only download chunks you watch

### P2P Networking
- **Hyperswarm** manages peer connections
- Videos are discovered via content hashes
- Multiple peers can serve the same video
- Automatic load balancing across peers

### Metadata
- **Hyperbee** stores video metadata (titles, descriptions, tags)
- **Autobase** provides multi-writer global discovery index
- Comments stored as tree structures in Hyperbee

### Identity
- Self-sovereign keypairs (no central authority)
- BIP39 mnemonic for recovery
- Channels are tied to public keys

## Contributing

This project is in early development. Contributions welcome!

## License

MIT
