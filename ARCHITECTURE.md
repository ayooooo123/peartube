# PearTube Architecture

## Overview

PearTube is a decentralized P2P video platform designed to replace centralized services like YouTube. It leverages the Hypercore Protocol for distributed storage and networking, enabling a serverless, censorship-resistant video platform that scales with its user base.

## Design Principles

1. **No Central Servers**: All data is stored and served P2P
2. **Self-Sovereign Identity**: Users control their own keys and data
3. **Bandwidth Efficient**: Sparse replication and adaptive streaming
4. **Auto-Scaling**: Popular content = more seeders naturally
5. **Simple Architecture**: Minimal complexity, maximum reliability

## System Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React)                     │
│  - Video Player    - Channel UI    - Search/Browse     │
│  - Upload UI       - Comments      - Settings          │
└──────────────────┬──────────────────────────────────────┘
                   │ RPC (tiny-buffer-rpc)
                   │
┌──────────────────▼──────────────────────────────────────┐
│              Backend Worker (Node.js)                   │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Video Delivery Engine                               │ │
│ │ - Multi-peer chunk assembly                         │ │
│ │ - Adaptive bitrate                                  │ │
│ │ - Seeding management                                │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Content Core                                        │ │
│ │ - Channel management                                │ │
│ │ - Hyperdrive operations                             │ │
│ │ - Metadata sync                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Discovery Core                                      │ │
│ │ - Search engine                                     │ │
│ │ - Swarm management                                  │ │
│ │ - Subscription sync                                 │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│           Hypercore Protocol Stack                      │
│  - Hyperswarm (networking)                              │
│  - Hyperdrive (file storage)                            │
│  - Hyperbee (metadata)                                  │
│  - Autobase (multi-writer)                              │
└─────────────────────────────────────────────────────────┘
```

## Data Layer

### Per-Channel Data Structures

Each channel has:

1. **Hyperdrive** - Stores all video files and assets
   - Video segments (HLS .ts files)
   - Manifests (.m3u8 playlists)
   - Thumbnails
   - Channel artwork
   - Subtitles/captions

2. **Hyperbee** - Stores channel metadata
   ```
   /videos/{videoId}/metadata
   /videos/{videoId}/comments
   /channel/info
   /channel/playlists
   ```

### Global Data Structures

1. **Discovery Index** (Autobase - multi-writer)
   - Channel directory
   - Tag index
   - Trending cache
   - Full-text search index

## Video Format

### Encoding Strategy

Videos are transcoded to multiple qualities:
- 360p (H.264, ~800 kbps)
- 720p (H.264, ~2.5 Mbps)
- 1080p (H.264, ~5 Mbps)
- 1440p/4K (Optional, H.265, ~10-20 Mbps)

### Segmentation

- **Format**: HLS (HTTP Live Streaming)
- **Segment duration**: 4 seconds
- **Container**: Fragmented MP4 or MPEG-TS
- **Adaptive**: Multiple quality levels with .m3u8 manifest

### Storage Layout in Hyperdrive

```
/videos/{videoId}/
  ├── manifest.m3u8          # Master playlist
  ├── 360p/
  │   ├── playlist.m3u8      # Quality-specific playlist
  │   ├── segment_0.ts
  │   ├── segment_1.ts
  │   └── ...
  ├── 720p/
  │   └── ...
  ├── 1080p/
  │   └── ...
  └── thumbnail.jpg
```

## P2P Networking

### Swarm Strategy

- **Topic-based swarms**: Each video has a swarm based on its hash
- **Channel swarms**: Subscribers join channel's swarm for updates
- **Discovery swarm**: Global swarm for finding new content

### Peer Selection

1. **Prioritize peers with needed chunks**
2. **Prefer fast peers** (track download speeds)
3. **Geographic proximity** (lower latency)
4. **Limit connections** (max 50 peers per video)

### Bandwidth Management

- **Smart prefetching**: Download upcoming segments in advance
- **Quality selection**: Adapt bitrate to available bandwidth
- **Upload limits**: Configurable seeding bandwidth cap
- **Priority seeding**: Seed rare content over popular content

## Video Playback Flow

1. **User clicks video**
   - Frontend requests video metadata via RPC
   - Backend fetches from Hyperbee

2. **Join swarm**
   - Backend announces to Hyperswarm for video topic
   - Connects to peers who have the video

3. **Stream segments**
   - Player requests segments via HLS protocol
   - Backend fetches chunks from multiple peers in parallel
   - Streams assembled segments to player

4. **Adaptive streaming**
   - Monitor download speed
   - Switch quality levels as needed
   - Prefetch next N segments

5. **Seeding**
   - Cache downloaded segments
   - Announce availability to swarm
   - Serve to other peers

## Identity & Cryptography

### Keypair Generation

- **Algorithm**: Ed25519
- **Recovery**: BIP39 mnemonic (24 words)
- **Storage**: Encrypted locally with user password

### Channel Ownership

- **Public key** = Channel ID
- **Private key** = Signing authority
- **All content signed** for authenticity
- **No password recovery** (self-sovereign)

### Trust Model

- **No central authority**
- **User-based blocking** (local block lists)
- **Community moderation** (optional shared block lists)
- **Content authenticity** (signature verification)

## Discovery & Search

### Indexing Strategy

1. **Local index** (each user)
   - Subscribed channels
   - Watched videos
   - Cached metadata

2. **DHT-based discovery**
   - Announce channels to DHT
   - Query by tags/keywords
   - No global coordinator

3. **Collaborative filtering** (optional)
   - Users can join "index swarms"
   - Share discovery indices
   - Faster search with more participants

### Search Algorithm

1. Query local index first (instant)
2. Query subscribed channels' metadata
3. Query discovery swarms for broader results
4. Rank by relevance + popularity + freshness

## Scaling Properties

### How It Scales

| Factor | Impact |
|--------|--------|
| More users | More peers = faster downloads |
| Popular video | More seeders = better distribution |
| More storage | Users cache more content |
| More bandwidth | Network serves more concurrent streams |

### Bottlenecks

| Bottleneck | Solution |
|------------|----------|
| Initial seed | Creator must seed; optional pinning services |
| Discovery latency | DHT lookups can be slow; use local cache |
| Rare content | May have few/no seeders; encourage pinning |
| Large videos | Sparse replication; only download watched parts |

## Security Considerations

### Threats

1. **Malicious content**: Users control uploads
2. **Copyright**: Decentralized = hard to enforce DMCA
3. **Spam/abuse**: No central moderation
4. **Sybil attacks**: Fake peers, fake popularity

### Mitigations

1. **Content signing**: Verify uploader identity
2. **User-level filtering**: Each user controls what they see
3. **Reputation systems**: Trust scores for channels
4. **Resource limits**: Prevent DoS via bandwidth caps
5. **Privacy**: No central tracking of viewing habits

## Future Enhancements

1. **Live Streaming**: Real-time video via Hyperswarm
2. **Offline Mode**: Full local cache for offline playback
3. **Mobile Apps**: React Native + Hypercore
4. **Federation**: Bridge to ActivityPub/Mastodon
5. **Monetization**: Lightning Network tips
6. **AI Moderation**: Optional local content filtering
7. **Transcoding Services**: Optional paid encoding nodes

## Comparison to Centralized Platforms

| Feature | YouTube | PearTube |
|---------|---------|----------|
| Hosting | Google servers | P2P (all users) |
| Costs | Google pays | Distributed |
| Censorship | Platform decides | User decides |
| Identity | Google account | Self-sovereign keys |
| Privacy | Tracked by Google | No central tracking |
| Scaling | Data centers | Grows with users |
| Bandwidth | Google CDN | Peer mesh |
| Monetization | Ads + cuts | Direct (optional) |

## Inspiration from Keet

Key patterns learned from Keet:

1. **Worker architecture**: Separate P2P logic from UI
2. **RPC pattern**: Clean frontend-backend separation
3. **Hyperbee for metadata**: Fast key-value lookups
4. **Sparse replication**: Bandwidth efficiency
5. **Identity model**: Self-sovereign keypairs
6. **Subscription pattern**: Real-time RPC updates
7. **Build tooling**: SWC for fast compilation
