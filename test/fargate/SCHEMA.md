# Contracts: environment, log lines, files

Every line a probe or the owner client writes to stdout is one JSON object. Lines that are
not JSON (the stock containers' own logs) are kept by `collect` but ignored by `report`.

## Environment given to the `probe` container (all kinds)

| Variable | Meaning |
|---|---|
| `RUN` | run id, e.g. `r20261121a` |
| `KIND` | `peartube` \| `blind-peer` \| `blind-relay` \| `relayed-peer` |
| `ROLE` | `pt-direct` \| `pt-relayed` \| `bp` \| `br` \| `rp` |
| `DEADLINE_MIN` | minutes after start at which the probe exits (the task then stops) |
| `SAMPLE_MS` | sample period, default `5000` |
| `CHANNEL_KEY` | 64-hex channel key |
| `SUBSET_JSON` | the subset as one JSON string (`subset.json` contents) |
| `RELAY_KEYS` | csv of 64-hex blind relay keys known at launch (may be empty) |
| `TOPIC_SEED` | string; the probes' Hyperswarm topic is `sha256('peartube-fargate-swarm/' + TOPIC_SEED)` |
| `PT_API` | `peartube` only: `http://127.0.0.1:8174` |
| `BP_STORE` | `blind-peer` only: `/bpstore` (read-only mount of the blind peer's store volume) |
| `SHARED_LOG` | `blind-relay` only: `/shared/relay.log` (the relay's stdout, tee'd) |
| `RP_MAX_CONNS` | `relayed-peer` only: concurrent relayed connections to keep, default `6` |

`ECS_CONTAINER_METADATA_URI_V4` is set by Fargate; the probe reads `${URI}/task` once and
`${URI}/task/stats` every sample.

## Probe sample line (every `SAMPLE_MS`)

```json
{"v":1,"type":"sample","run":"…","kind":"…","role":"…","task":"<first 8 hex of the task id>",
 "ts":1763740000000,"t":12345,
 "ecs":{"cpuPct":{"<container name>":12.3},"memBytes":{"<container name>":123456},"rx":123,"tx":456},
 "pt":{"peers":2,"lanPeers":0,"publicPeers":2,"rxBytes":0,"txBytes":0,"downBps":0,"upBps":0,"cachedBytes":0,"rtt":0,"retransmits":0,
       "rep":{"enabled":true,"replicating":true,"replicatedBytes":0,"replicatedEntries":0,"totalEntries":17,"targetBytes":0,"skippedDiskFull":0,"skippedUnavailable":0,"activeSlices":1,"freeDiskBytes":0}},
 "bp":{"storeBytes":0,"key":"<z32 or hex, once known>"},
 "br":{"key":"<hex, once known>"},
 "rp":{"conns":[{"peer":"<hex8>","relay":"<hex8>","remote":"ip:port","pairMs":1200,"ageMs":60000,"rx":0,"tx":0,"rtt":40,"ok":true}],
       "cores":{"<hex8>":{"length":100,"have":40}},"haveBytes":0,"targetBytes":0,"firstByteT":null,"fullCopyT":null,
       "reads":[{"peer":"<hex8>","relay":"<hex8>","bytes":4194304,"ms":800}]},
 "probe":{"key":"<hex>","nat":{"firewalled":true,"randomized":false,"host":"…","port":0},
          "connects":{"client":{"attempted":0,"opened":0},"server":{"attempted":0,"opened":0}},
          "conns":[{"peer":"<hex8>","remote":"ip:port","relayed":false,"relay":null,"dir":"out","rtt":0,"ageMs":0}],
          "relayTests":[{"relay":"<hex8>","peer":"<hex8>","pairMs":0,"bytes":16777216,"ms":0,"mbps":0,"rttMs":0,"directRttMs":0,"ok":true,"err":null}]}}
```

`cpuPct` is the container's CPU as a percentage of the task's vCPU allocation
(`cpu_stats.cpu_usage.total_usage` delta over `system_cpu_usage` delta, times online CPUs,
times 100, divided by task vCPUs). `rx`/`tx` are the task ENI counters from `networks`.
Only the section for the task's kind is present (`pt`, `bp`, `br`, `rp`); `ecs` and `probe`
are always present. `t` is milliseconds since the probe started.

## Probe event lines

`{"v":1,"type":"event","run","kind","role","task","ts","t","ev":"start"|"ready"|"first-byte"|"full-copy"|"deadline"|"error"|"relay-pair"|"conn-open"|"conn-close","detail":{…}}`

`start` carries `{"taskArn":"…","startedAt":"…","vcpu":0.5,"memMiB":1024,"image":"…"}` (the ARN is
stripped by `collect`). `first-byte` and `full-copy` are emitted once, for storage kinds, from
the kind's own counter (`pt.rep.replicatedBytes`, `bp.storeBytes` growth beyond 1 MiB,
`rp.haveBytes`). `conn-open`/`conn-close` on the relayed peer carry the connection record.

## Owner client lines (`owner/requester.mjs`, written to `results/<run>/owner.jsonl`)

`{"v":1,"type":"owner","run","ts","bp":"<hex>","ev":"connect"|"added"|"progress"|"error","remote":"ip:port","cores":{"<hex8>":{"length":n,"remoteLength":n,"remoteContiguous":n}},"haveBytes":n,"targetBytes":n,"detail":{…}}`

## Scrape lines (`lib/scrape.mjs`, `results/<run>/scrape.jsonl`)

`{"v":1,"type":"scrape","run","ts","alias":"…","metrics":{"<name>":<number or {labels:value}>}}`

## `subset.json`

```json
{"channel":"<64 hex>","pickedAt":"<iso>","rule":"…","entries":[{"id":"…","blobs":"<64 hex>","blockOffset":0,"blockLength":n,"size":n,"sha256":"<64 hex>"}],"totalBytes":n}
```

`id` is the catalog id (`imdb:…`/`clip:…`), never a title.

## `results/<run>/tasks.json`

`[{"task":"<hex8>","kind","role","step":1,"launchedAt","startedAt","stoppedAt","stopCode","publicIp","vcpu","memMiB","image"}]`

## Task definition variables (`taskdefs/*.json`, `${NAME}` substitution)

`RUN`, `IMAGE_PT`, `IMAGE_BP`, `IMAGE_BR`, `IMAGE_PROBE`, `EXEC_ROLE_ARN`, `LOG_GROUP`,
`AWS_REGION`, `CPU`, `MEMORY`, `CHANNEL_KEY`, `REPLICATE_KEYS`, `RELAY_KEYS`, `OWNER_PUB`,
`SCRAPER_PUB`, `SCRAPER_SECRET`, `DEADLINE_MIN`, `BP_SHUTDOWN_MIN`, `BR_TIMEOUT_SEC`,
`TOPIC_SEED`, `SUBSET_JSON`.
