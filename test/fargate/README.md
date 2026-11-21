# Fargate swarm test

A measured run of PearTube's real network from AWS Fargate: PearTube relays, stock
Holepunch blind peers and stock blind relays, scaled 1 → 5 → 20 tasks, against one real
PearTube channel served from the channel owner's home relays. Everything here is test
infrastructure; nothing under `src/` changes. All of it is deleted from AWS at the end.

The question it answers with data: can a volunteer's *stock* blind peer seed PearTube
content (channel cores and media cores) and can a volunteer's *stock* blind relay carry
PearTube connections, compared with PearTube's own relays?

## What runs

One ECS cluster, standalone tasks (`ecs run-task`, never a service: nothing may restart
a task), Fargate `awsvpc` in the default VPC's public subnets, a security group with **no
inbound rules**, a public IP for outbound only. A task's public IP is a 1:1 static NAT, so
the task is a firewalled, port-consistent peer: holepunching works, unsolicited inbound
does not.

Every task has two containers. The second, `probe`, is the same image in every task kind
and is `essential`: when it exits at its deadline the task stops.

| Task kind | Container 1 (the peer under test) | What it is told |
|---|---|---|
| `peartube` | `ghcr.io/ayooooo123/peartube-relay:sha-<main commit>` (the relay image CI built from the commit this branch is based on), Bare as PID 1, no shell | `PEARTUBE_SOURCES=<channel key>`, `PEARTUBE_REPLICATE=<csv of the subset's blob core keys>`, `PEARTUBE_REPLICATE_FREE_GB=2`, `PEARTUBE_REPLICATE_MBPS=0`, `PEARTUBE_PUBLISH_CHANNEL=0`. The `pt-relayed` variant adds `PEARTUBE_RELAY_THROUGH=<csv of blind relay keys>` (`src/settings.js:19`), which PearTube uses only when a connection is forced onto a relay (`src/node/network.js:77`; Hyperswarm forces it after `REMOTE_NOT_HOLEPUNCHABLE`, `HOLEPUNCH_ABORTED`, `CANNOT_HOLEPUNCH` or `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, `hyperswarm/index.js:225-231,674-681`) |
| `blind-peer` | `tetherto/blind-peer:v1.15.1-r7` (holepunchto/blind-peer-docker, stock entrypoint, run exactly as a volunteer would) | `--trusted-peer <the channel owner's key>`, `--active-corestore` (without it the stock passive store never pulls the channel's bootstrap core; see `design/volunteer-peers.md` §1), `--max-storage 15000`, `--auto-shutdown-minutes <deadline>`, `--scraper-public-key/--scraper-secret <the run's scraper>`. Nothing else: no PearTube code, no channel key. The owner's client (`owner/requester.mjs`, `blind-peering` 2.11.0, the last release whose `add-cores` the image's muxer 1.6.0 understands; run from the operator's machine) connects to it by its public key and asks it to keep the cores |
| `blind-relay` | `node:22-alpine` + `blind-relay-service@2.2.2` (stock npm package; the only thing added is `timeout` for the deadline and `tee` for the key) | `--storage /data --port 49737 --scraper-public-key/--scraper-secret <the run's scraper>` |
| `relayed-peer` | the probe image alone (`probe/relayed-peer.mjs`): a Corestore peer that can reach other peers only through a blind relay. It finds the channel's peers with `dht.lookup(discoveryKey(channel key))`, dials each with `dht.connect(key, { relayThrough: <a blind relay key>, holepunch: () => false, relayAddresses })`, replicates its Corestore on the connection and downloads the subset's cores | the channel key, the subset's keys, the blind relay keys |

The relayed peer exists because nothing in Fargate fails to holepunch on its own: a task is
a port-consistent firewalled peer and punches with every consistent or randomized peer, so
a `pt-relayed` task's `PEARTUBE_RELAY_THROUGH` is never exercised (Hyperswarm forces a relay
only after `HOLEPUNCH_ABORTED`, `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, `CANNOT_HOLEPUNCH` or
`REMOTE_NOT_HOLEPUNCHABLE`, `hyperswarm/index.js:225-231,674-681`, and a server that refuses
to punch yields `REMOTE_ABORTED`, which is not one of them, `hyperdht/lib/connect.js:581`).
The one stock lever is on the dialing side: a client that names a relay in its handshake
(`relayThrough`) and aborts its own holepunch (`holepunch: () => false`,
`hyperdht/lib/connect.js:320-331`) keeps the relayed stream (`:766`), and any stock hyperdht
server pairs with the client's relay without configuration of its own
(`hyperdht/lib/server.js:429-430`). So the relayed peer stands for a viewer or seeder behind
a NAT that cannot be punched, and every PearTube relay, home or Fargate, serves it the real
media cores through the blind relay. `pt-relayed` tasks keep `PEARTUBE_RELAY_THROUGH` set so
that any forced relay PearTube itself performs is counted; the report says how many there were.

Why `PEARTUBE_REPLICATE_FREE_GB=2` and `PEARTUBE_REPLICATE_MBPS=0`: the defaults (20 GB
reserve, `src/settings.js:33`; 80 Mbps pacer, `:34`, `src/mirror.js:664`) would make every
Fargate task skip replication (`skippedDiskFull`, `src/mirror.js:871-879`) or measure the
throttle. Each task keeps Fargate's free 20 GiB of ephemeral storage; the subset is small,
so no task comes near the 2 GB reserve.

### The content: one real channel, a fixed subset

`prepare` reads the owner's relay API (`/v1/status`, `/v1/entries`) and writes
`subset.json`: the channel key and the blob core keys, sizes and sha256 of the entries to
mirror. The whole channel is far larger than the budget (hundreds of entries, terabytes),
so the test mirrors a fixed subset: the smallest entries that both home relays hold whole,
between 100 MB and 1.2 GB each, oldest-first by size, until 2.5 GB. "Full copy" means every
byte of that subset. `PEARTUBE_REPLICATE=<keys>` is the stock filter for exactly this:
`src/mirror.js:766-805` keeps only slices whose owner set contains a listed key, and a
per-video core's own key is in that set (`:793`).

For blind peers the owner's client asks for the same cores plus the channel's bootstrap
core (the channel key), with `announce: true` so the blind peer joins their topics itself
and finds the home relays and the other tasks (`blind-peer/index.js` `_announceCore`); it
holds nothing itself and pushes nothing.

### Route evidence

Every transfer in the report carries evidence from the transfer itself, never from a
separate probe connection or from ECS network totals:

- PearTube's own counters: `/v1/status` peers, `routes.public.peers`, rx/tx bytes and
  `/v1/plugins` `p2p-replicate` bytes and entries, sampled every 5 s.
- The remote address on the actual replication stream, logged by the peers whose code is
  ours to read: the relayed peer and the owner client log, per connection, the remote
  public key, `rawStream.remoteHost:remotePort`, whether that address is a blind relay's,
  and the stream's bytes sent and received (`udx` stream counters). A `peartube` direct
  task has no relay configured, so every connection it makes is direct by construction; a
  relayed transfer with a PearTube relay is evidenced by the relayed peer's log of that
  stream, the relay's own counters and PearTube's own peer and byte counters over the same
  interval.
- The blind relay's and blind peer's own counters, read the stock way: a `dht-prometheus`
  scraper (`gitlab.com/dcent-tech/dht-prometheus`, run on the operator's machine with a
  keypair seed and shared secret made for the run) that both services register with
  (`--scraper-public-key`, `--scraper-secret`). `blind-relay-service/bin.mjs:99-180`
  publishes `blind_relay_sessions_*`, `blind_relay_pairings_*` and `blind_relay_streams_*`;
  `blind-peer` publishes `blind_peer_announced_cores`, wakeup and stats counters
  (`blind-peer/index.js` `registerMetrics`). `watch` scrapes every target every 20 s into
  `results/<run>/scrape.jsonl`.

Numbers from the probes' own DHT nodes are labelled **connectivity check** in the report,
never "holepunch success": they show what a fresh peer in the same network position could
do, not what PearTube's transfers did.

### Steps and the mix

| Step | Total | `peartube` direct | `peartube` relayed | `blind-peer` | `blind-relay` | `relayed-peer` |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| 5 | 5 | 1 | 1 | 1 | 1 | 1 |
| 20 | 20 | 6 | 4 | 5 | 3 | 2 |

Tasks from earlier steps keep running; a step adds tasks. In a step the blind relays start
first and the rest once their keys are read from the logs (`Server listening on <id>`).

Gate before a scale step: every storage peer (`peartube`, `blind-peer`) reports completed
replica bytes for the subset and `skippedDiskFull = 0` (`/v1/plugins` → `p2p-replicate`
info; blind peers from the owner client's view of their cores). Blind relays store nothing
and have no such gate.

## What is measured

The probe writes one JSON line every 5 s to stdout → CloudWatch Logs; `collect` pulls
every line and `report` turns them into the tables. No metric comes from AWS Billing.

Per task: ECS task metadata v4 stats (CPU per container as a share of the task's vCPU,
memory per container, network rx/tx bytes), and per kind:

- `peartube`: `GET /v1/status` (peers, public peers, rx/tx bytes, down/up B/s, rtt,
  retransmits, cachedBytes) and `GET /v1/plugins` → `p2p-replicate` (replicatedBytes,
  replicatedEntries, totalEntries, targetBytes, skippedDiskFull, skippedUnavailable).
- `blind-peer`: bytes on disk in its store (the store volume is mounted read-only in the
  probe at `/bpstore`); the owner client logs, per blind peer and core, the remote length
  it sees over its replication connection; the scraper gives the blind peer's own counters.
- `blind-relay`: the relay's key; its own counters come from the scraper, its CPU and
  network from ECS stats.
- `relayed-peer`: per connection the remote key, the relay used, the stream's remote
  address and bytes, the time from dial to open (pairing), RTT on the relayed stream; per
  core the blocks held; a 4 MiB timed read at the start of each connection for throughput.

Every probe also runs a small HyperDHT node (`probe/dht-probe.mjs`), the **connectivity
check**: it joins one Hyperswarm topic for the run so probes find each other, keeps those
connections, and reports Hyperswarm's connect stats (`swarm.stats.connects.client/server
.attempted/.opened`), its NAT view (`dht.firewalled`, `dht.randomized`, host, port) and,
for each connection, the remote address. Against each blind relay it knows (keys gossiped on
the topic and given in `RELAY_KEYS`) it opens one forced relayed stream to one other probe
(`dht.connect(key, { relayThrough, holepunch: () => false })`) and measures pairing time, a
16 MiB transfer's throughput and RTT over the relayed stream against RTT over a direct
stream to the same probe (added latency), then keeps the stream open with a 0.5 Mbps
trickle so the relay carries it for the rest of the run. These numbers describe what a
fresh peer in the task's network position could do; they are never reported as PearTube's.

The report (per step and kind): time to first replicated byte, time to full copy, direct vs
relayed connections with their route evidence, per-peer and total throughput, CPU and
memory per task; for blind relays pairing time, forwarded bytes, throughput, added latency,
CPU per relayed stream and streams carried (from their own counters and the relayed peers'
logs); the connectivity check (opened / attempted); home-relay API latency and uplink bytes
during the step; and the cost from this test's own counters.

## Cost guard

Hard limits come from published us-east-2 prices (AWS Price List API, read 2026-11-21:
Fargate x86 $0.04048/vCPU-h, $0.004445/GB-h; ARM $0.03238/vCPU-h, $0.00356/GB-h; ephemeral
storage above 20 GiB $0.000111/GB-h; public IPv4 $0.005/h; data out to the internet
$0.09/GB; regional data between public IPs $0.01/GB each direction; CloudWatch Logs
$0.50/GB ingested; ECR $0.10/GB-month). The counters are this test's own: task start and
stop times from `describe-tasks`, bytes from the probes' network counters. `watch` stops
every task when any counter reaches 80 % of its limit, then reports. Each task expires on
its own (`DEADLINE_MIN` in the probe, `--auto-shutdown-minutes` on the blind peer,
`timeout` on the blind relay) and `stop` stops it from the operator's side as well. Each
step has a maximum wall time. An AWS Budget with `IncludeCredit=false` exists only as a
late backstop; budget data lags by hours.

## Commands

```
node test/fargate/swarm.mjs prepare --relay-api http://<home relay>:8174 [--relay-api ...]   # subset.json, baseline latency
node test/fargate/swarm.mjs up        # ECR repos, images, IAM execution role, log group, security group, cluster, task definitions, scraper keys
node test/fargate/swarm.mjs limits    # prints the hard-limits table (sizes, prices, caps) to show before step 1
node test/fargate/swarm.mjs scraper   # runs dht-prometheus for the run (foreground); watch reads it
node test/fargate/swarm.mjs step 1|5|20 [--max-minutes N]   # launch the step's tasks (blind relays first)
node test/fargate/swarm.mjs watch     # every 20 s: progress, gate, counters, scrape, home relay latency; stops at 80 % or max wall time
node test/fargate/swarm.mjs stop      # stop every task in the cluster
node test/fargate/swarm.mjs collect   # CloudWatch events + describe-tasks → results/<run>/events.jsonl, tasks.json
node test/fargate/swarm.mjs report    # results/<run>/report.md and summary.json
node test/fargate/swarm.mjs down      # delete everything this test created
node test/fargate/swarm.mjs check     # prove nothing is left (ECS, ECR, logs, SG, IAM, budget)
node test/fargate/owner/requester.mjs --run <run> --subset test/fargate/subset.json --blind-peer <key>...   # the channel owner's client
```

`AWS_PROFILE` and `AWS_REGION` come from the environment. Every AWS resource is named
`peartube-fargate-swarm-<run>` and tagged `peartube-fargate-swarm=<run>`; `down` and `check`
go by name and tag.

## Privacy

Nothing here may carry an AWS account id, a home or LAN address, a user name or a home
directory. Relay API addresses are command-line arguments. `collect` replaces task and
resource ARNs with short task ids before writing `results/`, and `results/` holds keys,
sizes and numbers, never titles.

## Files

| Path | Purpose |
|---|---|
| `swarm.mjs` | The operator's tool: every command above. Node 22, no npm dependencies; AWS through the `aws` CLI. |
| `lib/aws.mjs`, `lib/cost.mjs`, `lib/report.mjs`, `lib/subset.mjs`, `lib/scrape.mjs` | AWS calls, the limits and counters, the report, the subset picker, the scraper reader. |
| `probe/` | The probe image: `Dockerfile`, `package.json`, `probe.mjs` (sampler, deadline, kind-specific readers), `dht-probe.mjs` (the connectivity check), `relayed-peer.mjs` (the peer that can only use a relay). |
| `blind-relay/Dockerfile` | `node:22-alpine` + `blind-relay-service`. |
| `owner/requester.mjs` | The channel owner's client for blind peers: `blind-peering` over `hyperdht`, keypair from `OWNER_SEED`, asks each blind peer for the channel's bootstrap core and the subset's blob cores with `announce: true`, logs what each blind peer holds. |
| `owner/package.json` | `blind-peering`, `hyperdht`, `corestore`, `dht-prometheus` for the operator's machine. |
| `taskdefs/*.json` | Task definition templates with `${VAR}` placeholders. |
| `subset.json` | The channel key and the subset's cores (keys, sizes, sha256). |
| `results/<run>/` | `events.jsonl`, `tasks.json`, `scrape.jsonl`, `home.jsonl`, `owner.jsonl`, `cost.json`, `summary.json`, `report.md`. |

Run state that must not enter the repository (the scraper seed and secret, the owner seed,
resource ids) lives in `$XDG_CACHE_HOME/peartube-fargate/<run>/` (default `~/.cache/peartube-fargate/<run>/`).
