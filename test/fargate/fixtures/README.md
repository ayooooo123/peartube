# Report fixture

`events.sample.jsonl` is a fictional run for `lib/report.mjs`. It needs no AWS,
network, npm package or credentials. Every line follows the contracts in
`../SCHEMA.md`.

The fixture is one file so `writeReport` can run from a directory that has no
`tasks.json`; that absence exercises the event-based task inference. The fixture
also embeds `owner`, `scrape` and `home` lines, which the report accepts from
either `events.sample.jsonl` or the optional `owner.jsonl`, `scrape.jsonl` and
`home.jsonl` files.

## What it covers

- 20 tasks after the 1, 5 and 20 steps, with tasks from earlier steps still
  running: 6 `pt-direct`, 4 `pt-relayed`, 5 `blind-peer`, 3 `blind-relay` and
  2 `relayed-peer`.
- `start`, `ready`, `first-byte`, `full-copy`, `deadline`, `conn-open`,
  `conn-close` and `relay-pair` events.
- Nine samples per task with ECS CPU, memory, rx and tx, plus the section for
  the task's kind: `pt` and `p2p-replicate` counters, blind peer store bytes,
  blind relay key, relayed-peer connections/cores/reads, and the probe's NAT,
  connect stats and forced relay tests.
- Three steps of owner-client lines, scraper counter lines, and home relay
  latency and cumulative uplink samples.
- Two relay keys on the relayed streams, so the route table does not collapse
  to a single relay.
- One `raw` JSON line for a stock container log. The report ignores it.

All addresses are RFC 5737 documentation addresses (`192.0.2.0/24`,
`198.51.100.0/24`). Keys, task ids and image names are fictional. The file has
no account id, personal identifier, home or LAN address, secret or email.

## Home and scrape line shapes

`SCHEMA.md` defines the sample, event, owner and scrape lines. It does not
define `home.jsonl`; `lib/home.mjs` writes one line per relay, and the report
reads that shape:

```json
{"type":"home","relay":"0","ts":1763740000000,
 "ms":38,"upBps":125000,"txBytes":100000000,"peers":3,"ok":true}
```

`relay` is the relay's position in the operator's list; no URL or address is
written. `ms` is the API latency and `txBytes` is a cumulative uplink counter. A
failed sample keeps its measured `ms` but its null counters are not used: the
report takes latency and tx only from `ok:true` samples, shows the last minus
first counter inside each step window, and reports a reset instead of smoothing
it. The report also accepts a `relays` array of `{alias, ms, txBytes}` objects.

`lib/scrape.mjs` writes the Prometheus parser's shape: an unlabelled series is a
number, and labelled series of one name are an object keyed by the label set:

```json
{"blind_relay_pairings_active":3,
 "blind_relay_streams_opened":{"kind=\"direct\"":2,"kind=\"relayed\"":1}}
```

The report prints the labels and values. It also accepts
`{"labels":{"dir":"tx"},"value":123}`.

## Run the report

From the repository root:

```sh
node --input-type=module -e "import('./test/fargate/lib/report.mjs').then(m => m.writeReport({ run: 'sample', from: 'test/fargate/fixtures', resultsDir: '/tmp/peartube-fargate-sample', logBytes: 400000000 }))"
```

`logBytes` is optional. It is the CloudWatch Logs ingested byte count; passing it
exercises the expected log cost. Without it, the log cells read
`n/a: no logBytes input; pass the CloudWatch ingested size` and the expected
total is marked partial.

`writeReport` writes three files into `resultsDir`:

- `report.md`: the five tables.
- `summary.json`: the same model as JSON, with null and a reason for each
  missing value.
- `cost.json`: `calculateCost` output, including per-task and per-step cost.

The fixture describes 20 tasks, 17 completed downloads and four relayed
streams over two relay keys. The expected cost is partial because the fixture
does not contain ECR image sizes. The hard-cap estimate is `$4.6905` before
ECR storage.

## Print the limits table

```sh
node --input-type=module -e "import('./test/fargate/lib/cost.mjs').then(m => console.log(m.limitsMarkdown()))"
```

The default prices are us-east-2, read 2026-11-21. The default 45/40/40 minute
schedule is 17.42 task-hours. The worst case at the trip point is `$3.7524`,
under the `$10.00` default ceiling.
