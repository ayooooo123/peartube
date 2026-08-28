#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
APP_ID="${APP_ID:-com.peartube.app}"
MAESTRO_BIN="${MAESTRO_BIN:-$HOME/.maestro/bin/maestro}"
ADB_BIN="${ADB_BIN:-$(command -v adb)}"
DEVICE_SERIAL="${DEVICE_SERIAL:-}"
LAUNCH_FLOW_PATH="${LAUNCH_FLOW_PATH:-$REPO_ROOT/.maestro/android-launch-only.yaml}"
WAIT_HOME_FLOW_PATH="${WAIT_HOME_FLOW_PATH:-$REPO_ROOT/.maestro/android-pip-open-from-feed-and-home.yaml}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/.artifacts/maestro-pip/$TIMESTAMP}"

VIDEO_ID_DEFAULT="280881bcdf6cef11e60d22e19da9a111"
CHANNEL_KEY_DEFAULT="cd29fcc6aaeee3613b5febf64316ce0fb61f86e5e0a668de6c61b333525d0130"
VIDEO_TITLE_DEFAULT="Accepted (2006) Bluray-1080p"

VIDEO_ID="${PEARTUBE_VIDEO_ID:-$VIDEO_ID_DEFAULT}"
CHANNEL_KEY="${PEARTUBE_CHANNEL_KEY:-$CHANNEL_KEY_DEFAULT}"
VIDEO_TITLE="${PEARTUBE_VIDEO_TITLE:-$VIDEO_TITLE_DEFAULT}"
PUBLIC_BEE_KEY="${PEARTUBE_PUBLIC_BEE_KEY:-}"

DEFAULT_DEEPLINK="peartube://video/${VIDEO_ID}?channel=${CHANNEL_KEY}"
if [[ -n "$PUBLIC_BEE_KEY" ]]; then
  DEFAULT_DEEPLINK+="&publicBee=${PUBLIC_BEE_KEY}"
fi
PEARTUBE_VIDEO_DEEPLINK="${PEARTUBE_VIDEO_DEEPLINK:-$DEFAULT_DEEPLINK}"

mkdir -p "$OUT_DIR"

if [[ ! -x "$MAESTRO_BIN" ]]; then
  echo "Maestro not found at $MAESTRO_BIN" >&2
  exit 1
fi

if [[ -z "$ADB_BIN" ]]; then
  echo "adb not found in PATH" >&2
  exit 1
fi

if [[ -n "$DEVICE_SERIAL" ]]; then
  DEVICE_LINE="$DEVICE_SERIAL"
  STATE="$($ADB_BIN -s "$DEVICE_LINE" get-state 2>/dev/null || true)"
  if [[ "$STATE" != "device" ]]; then
    echo "Requested device $DEVICE_LINE is not available" >&2
    exit 1
  fi
else
  DEVICE_LINE="$($ADB_BIN devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
  if [[ -z "$DEVICE_LINE" ]]; then
    echo "No connected Android device found" >&2
    exit 1
  fi
fi

FILTER_REGEX='PipBridge|MediaSession|MainActivity|PlayerActivity|onUserLeaveHint|notifyPipModeChanged|PiP_|VideoPlayerContext|VideoPlayerOverlay|Skipping network suspend|Connecting to P2P|setAutoPiP|setPipEnabled|Backend ready|Backend status probe succeeded'
BACKEND_READY_REGEX='\[App\] Backend ready, blobServerPort:|\[App\] Backend status probe succeeded before eventReady'

echo "Using device: $DEVICE_LINE"
echo "Deep link: $PEARTUBE_VIDEO_DEEPLINK"
echo "Artifacts: $OUT_DIR"

ADB_TARGET=("$ADB_BIN" -s "$DEVICE_LINE")
MAESTRO_DEVICE_ARGS=(--device "$DEVICE_LINE")

"${ADB_TARGET[@]}" logcat -c || true
"${ADB_TARGET[@]}" shell am force-stop "$APP_ID" || true

set +e
"$MAESTRO_BIN" test "$LAUNCH_FLOW_PATH" \
  "${MAESTRO_DEVICE_ARGS[@]}" \
  | tee "$OUT_DIR/maestro-launch-output.txt"
LAUNCH_EXIT=${PIPESTATUS[0]}
set -e

if [[ "$LAUNCH_EXIT" -ne 0 ]]; then
  echo "Initial Maestro app launch failed" >&2
  exit "$LAUNCH_EXIT"
fi

BACKEND_READY=no
for i in $(seq 1 45); do
  if "${ADB_TARGET[@]}" logcat -d | grep -E "$BACKEND_READY_REGEX" >/dev/null 2>&1; then
    BACKEND_READY=yes
    break
  fi
  sleep 2
done

if [[ "$BACKEND_READY" != "yes" ]]; then
  echo "Backend ready signal was not observed before feed automation" | tee "$OUT_DIR/backend-ready-wait.txt"
else
  echo "Backend ready signal observed before feed automation" | tee "$OUT_DIR/backend-ready-wait.txt"
fi

set +e
"$MAESTRO_BIN" test "$WAIT_HOME_FLOW_PATH" \
  "${MAESTRO_DEVICE_ARGS[@]}" \
  | tee "$OUT_DIR/maestro-output.txt"
MAESTRO_EXIT=${PIPESTATUS[0]}
set -e

sleep 2
PID="$("${ADB_TARGET[@]}" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r')"

"${ADB_TARGET[@]}" logcat -d > "$OUT_DIR/full-logcat.txt" || true
if [[ -n "$PID" ]]; then
  "${ADB_TARGET[@]}" logcat -d --pid="$PID" > "$OUT_DIR/app-logcat.txt" || true
else
  cp "$OUT_DIR/full-logcat.txt" "$OUT_DIR/app-logcat.txt"
fi

grep -E "$FILTER_REGEX" "$OUT_DIR/full-logcat.txt" > "$OUT_DIR/pip-filtered.txt" || true
"${ADB_TARGET[@]}" shell dumpsys activity activities > "$OUT_DIR/dumpsys-activity.txt" || true
"${ADB_TARGET[@]}" shell dumpsys activity containers > "$OUT_DIR/dumpsys-containers.txt" || true
"${ADB_TARGET[@]}" exec-out screencap -p > "$OUT_DIR/after-home.png" || true

ARMED=no
ENTERED=no
OVERLAY_SYMPTOM=no
if grep -q 'onUserLeaveHint: pipEnabled=true' "$OUT_DIR/pip-filtered.txt"; then
  ARMED=yes
fi
if grep -q 'notifyPipModeChanged: isInPip=true' "$OUT_DIR/pip-filtered.txt"; then
  ENTERED=yes
fi
if grep -q 'Connecting to P2P\|Skipping network suspend - local playback is active' "$OUT_DIR/pip-filtered.txt"; then
  OVERLAY_SYMPTOM=yes
fi

cat <<EOF

=== PearTube Android PiP Repro Summary ===
Maestro exit: $MAESTRO_EXIT
Device: $DEVICE_LINE
Deep link: $PEARTUBE_VIDEO_DEEPLINK
PiP armed at leave-hint: $ARMED
PiP entered callback observed: $ENTERED
Reconnect/overlay symptom observed: $OVERLAY_SYMPTOM
Artifacts:
  $OUT_DIR/maestro-output.txt
  $OUT_DIR/pip-filtered.txt
  $OUT_DIR/app-logcat.txt
  $OUT_DIR/full-logcat.txt
  $OUT_DIR/dumpsys-activity.txt
  $OUT_DIR/dumpsys-containers.txt
  $OUT_DIR/after-home.png
EOF

exit "$MAESTRO_EXIT"
