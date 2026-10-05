#!/bin/sh
set -eu

# A plain path file, never sourced as shell code. Each user pins their own runtime;
# package installation must not execute a user's NVM binary as root.
CONFIG_DIR="$HOME/.config/privcloud-companion"
NODE_CONFIG="$CONFIG_DIR/node-path"

validate_node() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *'
'*) return 1 ;;
  esac
  if printf '%s' "$1" | LC_ALL=C grep -q '[[:cntrl:]]'; then return 1; fi
  [ -f "$1" ] && [ -x "$1" ] &&
    NODE_OPTIONS='' "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
      </dev/null >/dev/null 2>&1
}

if [ "${1:-}" = "--configure-runtime" ]; then
  if [ "$#" -ne 2 ] || ! validate_node "$2"; then
    echo 'Usage: privcloud-companion --configure-runtime /absolute/path/to/node (Node.js 20+)' >&2
    exit 1
  fi
  umask 077
  mkdir -p "$CONFIG_DIR"
  temporary=$(mktemp "$CONFIG_DIR/node-path.XXXXXX")
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  printf '%s\n' "$2" > "$temporary"
  mv -f "$temporary" "$NODE_CONFIG"
  echo "PrivCloud Companion runtime configured: $2" >&2
  exit 0
fi

if [ -f "$NODE_CONFIG" ]; then
  NODE_BIN=$(cat "$NODE_CONFIG")
else
  NODE_BIN=$(command -v node || true)
fi
if ! validate_node "$NODE_BIN"; then
  echo 'PrivCloud Companion requires Node.js 20+. In your NVM shell, run without sudo:' >&2
  echo '  /usr/bin/privcloud-companion --configure-runtime "$(command -v node)"' >&2
  exit 1
fi

# Browser protocols own stdout; inherited instrumentation must not corrupt frames.
for argument in "$@"; do
  case "$argument" in
    --native-messaging|chrome-extension://*|moz-extension://*|companion@privcloud.fr) export NODE_OPTIONS='' ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/privcloud-companion.mjs" ]; then
  PAYLOAD="$SCRIPT_DIR/privcloud-companion.mjs"
else
  PAYLOAD="/opt/privcloud-companion/privcloud-companion.mjs"
fi
exec "$NODE_BIN" "$PAYLOAD" "$@"
