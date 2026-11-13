#!/bin/sh
# Swaps a PearTube relay host (systemd+podman on Linux/NUC, or Docker Compose on Unraid)
# cleanly between the Bare JS engine (`bin/relay.js`) and the native Rust engine (`peartube-relay`).
# Both engines mount the exact same /data Corestore + Autobee channel + settings.json + jobs.json.
#
#   peartube-engine status      show active engine, image, disk reserve, and live /v1/status
#   peartube-engine rust        switch to the native Rust relay and wait until /v1/status answers
#   peartube-engine js          switch to the Bare JS relay and wait until /v1/status answers
set -eu

CONF_DIR="${PEARTUBE_ENGINE_CONF_DIR:-$HOME/.config/peartube}"
ENV_FILE="$CONF_DIR/relay-engine.env"
UNIT="${PEARTUBE_SYSTEMD_UNIT:-peartube-prod.service}"
API_URL="${PEARTUBE_API_URL:-http://127.0.0.1:8174/v1/status}"

[ -f "$ENV_FILE" ] && . "$ENV_FILE"

JS_IMAGE="${PEARTUBE_JS_IMAGE:-ghcr.io/ayooooo123/peartube-relay:js}"
RUST_IMAGE="${PEARTUBE_RUST_IMAGE:-ghcr.io/ayooooo123/peartube-relay:rust}"
ACTIVE_ENGINE="${PEARTUBE_ENGINE:-rust}"
ACTIVE_IMAGE="${PEARTUBE_RELAY_IMAGE:-$RUST_IMAGE}"

write_env () {
  mkdir -p "$CONF_DIR"
  tmp="$ENV_FILE.tmp.$$"
  cat > "$tmp" <<EOF
PEARTUBE_ENGINE=$1
PEARTUBE_RELAY_IMAGE=$2
PEARTUBE_JS_IMAGE=$JS_IMAGE
PEARTUBE_RUST_IMAGE=$RUST_IMAGE
EOF
  chmod 0600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

restart_relay () {
  if [ -n "${PEARTUBE_COMPOSE_FILE:-}" ]; then
    PEARTUBE_ENGINE="$1" PEARTUBE_RELAY_IMAGE="$2" \
      docker compose -f "$PEARTUBE_COMPOSE_FILE" up -d --force-recreate
  else
    systemctl --user daemon-reload
    systemctl --user restart "$UNIT"
  fi
  i=0
  while [ "$i" -lt 25 ]; do
    if out=$(curl -sf "$API_URL" 2>/dev/null) && [ -n "$out" ]; then
      printf 'ready (%s -> %s): %s\n' "$1" "$2" "$out"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "relay did not answer at $API_URL within 25s" >&2
  return 1
}

cmd="${1:-status}"
case "$cmd" in
  status)
    printf 'engine=%s\nimage=%s\njs_image=%s\nrust_image=%s\n' \
      "$ACTIVE_ENGINE" "$ACTIVE_IMAGE" "$JS_IMAGE" "$RUST_IMAGE"
    if [ -z "${PEARTUBE_COMPOSE_FILE:-}" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl --user is-active "$UNIT" 2>/dev/null | sed 's/^/service=/' || true
    fi
    if out=$(curl -sf "$API_URL" 2>/dev/null) && [ -n "$out" ]; then
      printf 'status=%s\n' "$out"
    else
      echo "status=unreachable"
    fi
    ;;
  rust)
    write_env rust "$RUST_IMAGE"
    restart_relay rust "$RUST_IMAGE"
    ;;
  js)
    write_env js "$JS_IMAGE"
    restart_relay js "$JS_IMAGE"
    ;;
  *)
    echo "Usage: $(basename "$0") [status|rust|js]" >&2
    exit 2
    ;;
esac
