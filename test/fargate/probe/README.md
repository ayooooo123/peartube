# Fargate probe

Run `npm ci` in this directory, then start `node probe.mjs` with the variables in
`../SCHEMA.md`. Each stdout line is one JSON object. The probe exits after its
deadline. `RP_STORE` optionally changes the relayed peer's storage path for a
local run; the container default is `/data/rp`.

The connectivity check uses a separate DHT server key for its measurement
stream. The topic connection advertises that key. A relay test is successful
only while its stream uses the same remote host and port as an open connection
to the named relay. A direct shortcut is reported as an error, not as a relay
measurement. Reads reported by the relayed peer are approximate: Hypercore
may choose any connected peer for a missing block.

Build both architectures with Buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=/tmp/pt-swarm-probe.oci test/fargate/probe
```

For separate local images, use `docker build --platform linux/amd64 -t
pt-swarm-probe:amd64 test/fargate/probe` and the corresponding command with
`linux/arm64` and `pt-swarm-probe:local`. The image keeps both architectures'
prebuilds. It uses a glibc Node runtime because the RocksDB package does not
provide Alpine musl prebuilds.
