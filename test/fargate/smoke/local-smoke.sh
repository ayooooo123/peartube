#!/bin/sh
set -eu

cd "$(dirname "$0")/../../.."
: "${PT_HOME_RELAYS:?Set PT_HOME_RELAYS to the relay API URLs}"
SUBSET=${SUBSET:-test/fargate/subset.json}
WAIT_SEC=${SMOKE_WAIT_SEC:-600}
BP_PORT=${SMOKE_BP_PORT:-49741}
BR_PORT=${SMOKE_BR_PORT:-49737}
BP_IMAGE=tetherto/blind-peer:v1.15.1-r7
BP_NAME=pt-bp
BR_NAME=pt-swarm-br
work=$(mktemp -d "${TMPDIR:-/tmp}/peartube-fargate-smoke.XXXXXX")
bp_started=0
br_started=0
owner_pid=
bp_probe_pid=
rp_pid=
check_a_pid=
check_b_pid=

cleanup () {
  for pid in "$owner_pid" "$bp_probe_pid" "$rp_pid" "$check_a_pid" "$check_b_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || :; fi
  done
  for pid in "$owner_pid" "$bp_probe_pid" "$rp_pid" "$check_a_pid" "$check_b_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || :; fi
  done
  if [ "$bp_started" = 1 ]; then docker rm -f "$BP_NAME" >/dev/null 2>&1 || :; fi
  if [ "$br_started" = 1 ]; then docker rm -f "$BR_NAME" >/dev/null 2>&1 || :; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fail () { printf 'FAIL %s\n' "$*" >&2; exit 1; }

wait_for () {
  label=$1
  shift
  until_time=$(( $(date +%s) + WAIT_SEC ))
  until "$@"; do
    if [ "$(date +%s)" -ge "$until_time" ]; then fail "$label timed out"; fi
    for pid in "$owner_pid" "$bp_probe_pid" "$rp_pid" "$check_a_pid" "$check_b_pid"; do
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then fail "$label: a probe or requester exited"; fi
    done
    if [ "$bp_started" = 1 ] && [ "$(docker inspect -f '{{.State.Running}}' "$BP_NAME" 2>/dev/null || :)" != true ]; then fail 'blind peer exited'; fi
    if [ "$br_started" = 1 ] && [ "$(docker inspect -f '{{.State.Running}}' "$BR_NAME" 2>/dev/null || :)" != true ]; then fail 'blind relay exited'; fi
    sleep 2
  done
}

for command in node docker openssl; do command -v "$command" >/dev/null 2>&1 || fail "missing $command"; done
[ -f "$SUBSET" ] || fail 'subset is missing'
[ -d test/fargate/probe/node_modules ] || fail 'run npm ci in test/fargate/probe'
[ -d test/fargate/owner/node_modules ] || fail 'run npm ci in test/fargate/owner'
for image in "$BP_IMAGE" pt-swarm-probe:local pt-swarm-br:local; do docker image inspect "$image" >/dev/null 2>&1 || fail "missing image $image"; done
for name in "$BP_NAME" "$BR_NAME"; do if docker container inspect "$name" >/dev/null 2>&1; then fail "container $name already exists"; fi; done

node --input-type=module -e '
const urls = process.env.PT_HOME_RELAYS.split(",").filter(Boolean)
if (!urls.length) process.exit(1)
for (const url of urls) {
  const response = await fetch(url.replace(/\/$/, "") + "/v1/status", { signal: AbortSignal.timeout(5000) })
  if (!response.ok) process.exit(1)
}
console.log("PASS home relay status reads")
' || fail 'home relay status reads'

mkdir -p "$work/bp" "$work/br" "$work/shared" "$work/results" "$work/cache"
chmod 777 "$work/bp"
export OWNER_SEED
OWNER_SEED=$(openssl rand -hex 32)
OWNER_PUB=$(cd test/fargate/owner && node --input-type=module -e 'import DHT from "hyperdht"; console.log(DHT.keyPair(Buffer.from(process.env.OWNER_SEED,"hex")).publicKey.toString("hex"))')
printf 'Owner public key: %s\n' "$OWNER_PUB"
BP_VOLUME=$(docker image inspect "$BP_IMAGE" --format '{{range $path, $value := .Config.Volumes}}{{$path}}{{end}}')
[ -n "$BP_VOLUME" ] || fail 'blind peer image has no store volume'
bp_started=1
docker run --rm -d --name "$BP_NAME" -p "$BP_PORT:$BP_PORT/udp" -v "$work/bp:$BP_VOLUME" "$BP_IMAGE" --trusted-peer "$OWNER_PUB" --max-storage 5000 --auto-shutdown-minutes 60 --port "$BP_PORT" >/dev/null || fail 'starting blind peer'

bp_key () {
  docker logs "$BP_NAME" 2>&1 | node -e '
let text=""; process.stdin.on("data", c => text+=c).on("end", () => {
  for (const line of text.split("\n")) { try { const x=JSON.parse(line); if (x.msg === "Listening" && x.publicKey) { console.log(x.publicKey); return } } catch {} }
  process.exitCode=1
})'
}
have_bp_key () { bp_key >/dev/null; }
wait_for 'blind peer listening' have_bp_key
BP_KEY=$(bp_key)
printf 'PASS blind peer listening: %s\n' "$BP_KEY"

RUN=smoke-a KIND=blind-peer ROLE=bp DEADLINE_MIN=60 SAMPLE_MS=1000 TOPIC_SEED="smoke-a-$OWNER_PUB" BP_STORE="$work/bp" node test/fargate/probe/probe.mjs >"$work/bp-probe.jsonl" 2>"$work/bp-probe.err" &
bp_probe_pid=$!
XDG_CACHE_HOME="$work/cache" node test/fargate/owner/requester.mjs --run smoke-a --subset "$SUBSET" --blind-peer "$BP_KEY" --out "$work/results" >"$work/owner.stdout" 2>"$work/owner.err" &
owner_pid=$!

owner_growth () {
  node -e '
const fs=require("fs"); try {
 const entries=JSON.parse(fs.readFileSync(process.argv[2])).entries
 const keys=new Set(entries.map(x=>x.blobs.slice(0,8)))
 const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(x=>JSON.parse(x)).filter(x=>x.ev==="progress")
 const prior=new Map()
 for(const row of rows) for(const [key,core] of Object.entries(row.cores)) {
  if(!keys.has(key)) continue
  const old=prior.get(key)
  if(old && core.remoteContiguous>old.value) { if(process.argv[3]==="show") {console.log(JSON.stringify(old.row));console.log(JSON.stringify(row))} process.exit(0) }
  if(!old || core.remoteContiguous<old.value) prior.set(key,{value:core.remoteContiguous,row})
 }
} catch {} process.exit(1)
' "$work/results/owner.jsonl" "$SUBSET" "${1:-quiet}"
}
bp_growth () {
  node -e '
const fs=require("fs");try {const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const e=rows.find(x=>x.ev==="first-byte");if(e){if(process.argv[2]==="show"){console.log(JSON.stringify(e));const s=rows.find(x=>x.bp&&x.bp.storeBytes>=e.detail.storeBytes);if(s)console.log(JSON.stringify(s))}process.exit(0)}}catch{}process.exit(1)
' "$work/bp-probe.jsonl" "${1:-quiet}"
}
wait_for 'blind peer progress' owner_growth
owner_growth show
printf 'PASS blind peer remote contiguous blocks grew\n'
wait_for 'blind peer store growth' bp_growth
bp_growth show
printf 'PASS blind peer store grew by more than 1 MiB\n'

br_started=1
docker run --rm -d --name "$BR_NAME" -p "$BR_PORT:49737/udp" -v "$work/br:/data" -v "$work/shared:/shared" -e BR_TIMEOUT_SEC=3600 pt-swarm-br:local >/dev/null || fail 'starting blind relay'
relay_key () {
  node -e '
const fs=require("fs"),id=require("./test/fargate/probe/node_modules/hypercore-id-encoding");try {const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/Server listening on\s+([a-z0-9]{52})/i);if(m){console.log(id.decode(m[1]).toString("hex"));process.exit(0)}}catch{}process.exit(1)
' "$work/shared/relay.log"
}
wait_for 'blind relay listening' relay_key >/dev/null
RELAY_KEY=$(relay_key)
printf 'PASS blind relay listening: %s\n' "$RELAY_KEY"
CHANNEL_KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).channel)' "$SUBSET")
SUBSET_JSON=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))))' "$SUBSET")
RUN=smoke-b KIND=relayed-peer ROLE=rp DEADLINE_MIN=60 SAMPLE_MS=1000 TOPIC_SEED="smoke-b-$OWNER_PUB" RELAY_KEYS="$RELAY_KEY" CHANNEL_KEY="$CHANNEL_KEY" SUBSET_JSON="$SUBSET_JSON" RP_STORE="$work/rp" node test/fargate/probe/probe.mjs >"$work/rp.jsonl" 2>"$work/rp.err" &
rp_pid=$!

rp_growth () {
  node -e '
const fs=require("fs");try{const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const event=rows.find(x=>x.ev==="first-byte");const prior=new Map();for(const row of rows){if(!row.rp)continue;for(const c of row.rp.conns){if(!c.ok||!c.remote)continue;const key=c.peer+":"+c.relay+":"+c.remote;const old=prior.get(key);if(event&&old!==undefined&&c.rx>old){if(process.argv[2]==="show"){console.log(JSON.stringify(event));console.log(JSON.stringify(row))}process.exit(0)}if(old===undefined||c.rx<old)prior.set(key,c.rx)}}}catch{}process.exit(1)
' "$work/rp.jsonl" "${1:-quiet}"
}
wait_for 'relayed peer replication' rp_growth
rp_growth show
printf 'PASS relayed peer received media through the verified relay route\n'

RUN=smoke-c KIND=blind-relay ROLE=br DEADLINE_MIN=60 SAMPLE_MS=1000 TOPIC_SEED="smoke-c-$OWNER_PUB" RELAY_KEYS="$RELAY_KEY" SHARED_LOG="$work/shared/relay.log" node test/fargate/probe/probe.mjs >"$work/check-a.jsonl" 2>"$work/check-a.err" &
check_a_pid=$!
RUN=smoke-c KIND=blind-relay ROLE=br DEADLINE_MIN=60 SAMPLE_MS=1000 TOPIC_SEED="smoke-c-$OWNER_PUB" RELAY_KEYS="$RELAY_KEY" SHARED_LOG="$work/shared/relay.log" node test/fargate/probe/probe.mjs >"$work/check-b.jsonl" 2>"$work/check-b.err" &
check_b_pid=$!
connectivity () {
  node -e '
const fs=require("fs");try{const read=p=>fs.readFileSync(p,"utf8").trim().split("\n").map(JSON.parse).filter(x=>x.probe);const a=read(process.argv[1]),b=read(process.argv[2]);if(!a.length||!b.length)process.exit(1);const ak=a[0].probe.key.slice(0,8),bk=b[0].probe.key.slice(0,8);const ac=a.find(x=>x.probe.conns.some(c=>c.peer===bk)),bc=b.find(x=>x.probe.conns.some(c=>c.peer===ak));const tested=[...a,...b].find(x=>x.probe.relayTests.some(t=>t.ok&&t.bytes===16777216&&[t.pairMs,t.mbps,t.rttMs,t.directRttMs].every(Number.isFinite)));if(ac&&bc&&tested){if(process.argv[3]==="show"){console.log(JSON.stringify(ac));console.log(JSON.stringify(bc));console.log(JSON.stringify(tested))}process.exit(0)}}catch{}process.exit(1)
' "$work/check-a.jsonl" "$work/check-b.jsonl" "${1:-quiet}"
}
wait_for 'connectivity measurements' connectivity
connectivity show
printf 'PASS connectivity probes exchanged traffic through the verified relay route\n'
printf 'PASS local smoke\n'
