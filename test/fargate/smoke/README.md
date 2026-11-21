# Local smoke

This run uses the real channel, the public DHT and the home relays. It creates
a new owner seed and temporary stores, and it downloads part of the subset.
It reads the home relay status APIs but does not change the relays. It prints
measurement lines without titles. A failure is not evidence of a successful
transfer.

Install dependencies and build the images first:

```sh
npm --prefix test/fargate/probe ci
npm --prefix test/fargate/owner ci
docker pull tetherto/blind-peer:v1.15.1-r7
docker build --platform linux/arm64 -t pt-swarm-probe:local test/fargate/probe
docker build --platform linux/arm64 -t pt-swarm-br:local test/fargate/blind-relay
```

To build a multi-platform relay image instead, run:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=/tmp/pt-swarm-br.oci test/fargate/blind-relay
```

Set `PT_HOME_RELAYS` to the comma-separated API URLs, then run:

```sh
test/fargate/smoke/local-smoke.sh
```

The script checks the status APIs, blind peer progress and store growth,
relayed replication, and the two-probe connectivity measurements. It uses UDP
ports 49741 and 49737 by default. Set `SMOKE_BP_PORT` or `SMOKE_BR_PORT` if a
port is already in use. `SMOKE_WAIT_SEC` sets the timeout for each check.
The script removes its two containers, processes and temporary data on exit.
It refuses to replace existing containers with the same names.

A local DHT may select a direct path even when a caller requests a relay. The
probe rejects that path. In that case the smoke check fails rather than claim
that the relay carried the traffic.
