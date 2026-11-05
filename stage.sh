#!/bin/sh
# stage.sh: open ONE folder in VS Code, close the previous staged window first,
# type the payload out live with a glitch binary rain in the panel, wait for it,
# then verify the result.
#
#   stage.sh <project-dir> --payload <file> [--name <name-in-project>]
#           [--run "<command>"] [--no-rain] [--fps N] [--keep] [--wait SECONDS]
#           [--speed turbo|fast|normal|slow]
#   stage.sh --verify <project-dir>   # print the run log
#   stage.sh --close-all              # close every staged window, open none
#
# Must run unsandboxed: opening a window needs the host Wayland/DBus session.
set -eu

SKILL=$(cd "$(dirname "$0")" && pwd)
STATE="$SKILL/state"
REGISTRY="$STATE/windows.lst"
mkdir -p "$STATE"
: >> "$REGISTRY"

now() { date +%s; }

# A staged window proves it closed by writing closed.marker before it dies,
# which is the only reliable signal available without window-management tools.
close_window() {
  proj=$1
  [ -d "$proj" ] || return 0
  mkdir -p "$proj/.live-typer"
  rm -f "$proj/.live-typer/closed.marker"
  printf '{"action":"close","at":"%s"}\n' "$(date -Is)" > "$proj/.live-typer/control.json"
  start=$(now)
  while [ $(( $(now) - start )) -lt 8 ]; do
    if [ -f "$proj/.live-typer/closed.marker" ]; then
      echo "  closed : $proj"
      return 0
    fi
    sleep 0.4
  done
  echo "  STUCK  : $proj (no watcher alive: close it by hand, it predates the skill)"
  return 1
}

close_all_staged() {
  [ -s "$REGISTRY" ] || return 0
  echo "closing previously staged windows:"
  kept=""
  while IFS= read -r proj; do
    [ -n "$proj" ] || continue
    close_window "$proj" || kept="$kept$proj
"
  done < "$REGISTRY"
  # orphans from windows that died without taking their terminal with them
  pkill -f "$SKILL/assets/rain.py" 2>/dev/null || true
  printf '%s' "$kept" | grep -v '^$' > "$REGISTRY.new" 2>/dev/null || : > "$REGISTRY.new"
  mv "$REGISTRY.new" "$REGISTRY"
}

case "${1:-}" in
  --verify)
    log="${2:?usage: stage.sh --verify <project-dir>}/.live-typer/run.log"
    echo "--- $log"
    cat "$log" 2>/dev/null || echo "(no log yet: extension has not activated)"
    exit 0
    ;;
  --close-all)
    close_all_staged
    exit 0
    ;;
  "") echo "usage: stage.sh <project-dir> --payload <file> [--run \"<cmd>\"]" >&2; exit 2 ;;
esac

PROJECT=$1
shift
PAYLOAD=""
NAME=""
RUN=""
RAIN=true
FPS=22
KEEP=false
WAIT=150
SPEED=fast

while [ $# -gt 0 ]; do
  case "$1" in
    --payload) PAYLOAD=${2:?}; shift 2 ;;
    --name)    NAME=${2:?}; shift 2 ;;
    --run)     RUN=${2:?}; shift 2 ;;
    --no-rain) RAIN=false; shift ;;
    --fps)     FPS=${2:?}; shift 2 ;;
    --keep)    KEEP=true; shift ;;
    --wait)    WAIT=${2:?}; shift 2 ;;
    --speed)   SPEED=${2:?}; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$PAYLOAD" ] || { echo "need --payload <file>" >&2; exit 2; }
[ -f "$PAYLOAD" ] || { echo "payload not found: $PAYLOAD" >&2; exit 2; }

PROJECT=$(cd "$PROJECT" 2>/dev/null && pwd || { mkdir -p "$PROJECT" && cd "$PROJECT" && pwd; })
PAYLOAD=$(cd "$(dirname "$PAYLOAD")" && pwd)/$(basename "$PAYLOAD")
BASE=$(basename "$PAYLOAD")
[ -n "$NAME" ] || NAME="$BASE"

# one window at a time: close the last staged one before opening the next
if [ "$KEEP" = true ]; then
  echo "keeping previously staged windows (--keep)"
else
  close_all_staged
fi

# copy the payload out of the project: if the window dies mid-typing the target
# is left partial, and the original must survive that
cp "$PAYLOAD" "$STATE/payload-$BASE"

mkdir -p "$PROJECT/.live-typer"
: > "$PROJECT/.live-typer/run.log"
rm -f "$PROJECT/.live-typer/mission.json" "$PROJECT/.live-typer/closed.marker" \
      "$PROJECT/.live-typer/control.json"

python3 - "$STATE/payload-$BASE" "$PROJECT/.live-typer/mission.json" "$NAME" "$RUN" "$RAIN" "$FPS" "$SPEED" <<'PY'
import json, sys, time
payload, out, name, run, rain, fps, speed = sys.argv[1:8]
json.dump(
    {
        "payload": payload,
        "name": name,
        "run": run,
        "rain": rain == "true",
        "fps": int(fps),
        "speed": speed,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "runs": [],
    },
    open(out, "w"),
    indent=2,
)
PY

grep -qxF "$PROJECT" "$REGISTRY" 2>/dev/null || echo "$PROJECT" >> "$REGISTRY"

echo "project : $PROJECT"
echo "payload : $STATE/payload-$BASE  ($(wc -c < "$STATE/payload-$BASE") bytes)"
echo "target  : $PROJECT/$NAME"
echo "run     : ${RUN:-<none>}"
echo "rain    : $RAIN (fps $FPS)"
echo "speed   : $SPEED"

setsid nohup code --new-window --extensionDevelopmentPath="$SKILL/typer" "$PROJECT" \
  > "$STATE/launcher.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "opened  : code --new-window $PROJECT"
echo

# stream the run log until the extension says done, so one call is enough
LOG="$PROJECT/.live-typer/run.log"
start=$(now)
printed=0
while [ $(( $(now) - start )) -lt "$WAIT" ]; do
  if [ -f "$LOG" ]; then
    total=$(wc -l < "$LOG")
    if [ "$total" -gt "$printed" ]; then
      sed -n "$((printed + 1)),\$p" "$LOG"
      printed=$total
    fi
    if tail -1 "$LOG" | grep -q ' done$'; then break; fi
  fi
  sleep 1
done

echo
if [ -f "$PROJECT/$NAME" ] && cmp -s "$PROJECT/$NAME" "$STATE/payload-$BASE"; then
  echo "RESULT  : IDENTICAL ($(wc -c < "$PROJECT/$NAME") bytes, byte-for-byte)"
else
  echo "RESULT  : MISMATCH or missing target, check $LOG"
fi
