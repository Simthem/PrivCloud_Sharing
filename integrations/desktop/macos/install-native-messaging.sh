#!/bin/sh
set -eu

HOST_NAME="fr.privcloud.companion"
COMPANION_PATH="${PRIVCLOUD_COMPANION_PATH:-/Applications/PrivCloud Companion.app/Contents/MacOS/privcloud-companion}"
CHROME_EXTENSION_ID="${PRIVCLOUD_CHROME_EXTENSION_ID:-__CHROME_EXTENSION_ID__}"
EDGE_EXTENSION_ID="${PRIVCLOUD_EDGE_EXTENSION_ID:-__EDGE_EXTENSION_ID__}"
INSTALL_SCOPE="${1:-user}"

if [ ! -x "$COMPANION_PATH" ]; then
  echo "PrivCloud Companion binary not found or not executable: $COMPANION_PATH" >&2
  exit 1
fi

install_manifest() {
  target="$1"
  kind="$2"
  extension_id="$3"

  mkdir -p "$(dirname "$target")"
  if [ "$kind" = "firefox" ]; then
    cat > "$target" <<EOF
{
  "name": "$HOST_NAME",
  "description": "PrivCloud Companion native host",
  "path": "$COMPANION_PATH",
  "type": "stdio",
  "allowed_extensions": [
    "companion@privcloud.fr"
  ]
}
EOF
  else
    cat > "$target" <<EOF
{
  "name": "$HOST_NAME",
  "description": "PrivCloud Companion native host",
  "path": "$COMPANION_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$extension_id/"
  ]
}
EOF
  fi
  chmod 0644 "$target"
}

if [ "$INSTALL_SCOPE" = "--system" ]; then
  install_manifest "/Library/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json" chrome "$CHROME_EXTENSION_ID"
  install_manifest "/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$HOST_NAME.json" chrome "$EDGE_EXTENSION_ID"
  install_manifest "/Library/Application Support/Mozilla/NativeMessagingHosts/$HOST_NAME.json" firefox ""
else
  install_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json" chrome "$CHROME_EXTENSION_ID"
  install_manifest "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$HOST_NAME.json" chrome "$EDGE_EXTENSION_ID"
  install_manifest "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/$HOST_NAME.json" firefox ""
fi

echo "PrivCloud Companion native messaging host registered for macOS."

