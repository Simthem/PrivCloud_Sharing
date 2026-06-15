#!/bin/sh
set -eu

HOST_NAME="fr.privcloud.companion"
COMPANION_PATH="${PRIVCLOUD_COMPANION_PATH:-/opt/privcloud-companion/privcloud-companion}"
CHROME_EXTENSION_ID="${PRIVCLOUD_CHROME_EXTENSION_ID:-__CHROME_EXTENSION_ID__}"

if [ ! -x "$COMPANION_PATH" ]; then
  echo "PrivCloud Companion binary not found or not executable: $COMPANION_PATH" >&2
  exit 1
fi

install_manifest() {
  target="$1"
  kind="$2"
  mkdir -p "$(dirname "$target")"
  if [ "$kind" = "chrome" ]; then
    cat > "$target" <<EOF
{
  "name": "$HOST_NAME",
  "description": "PrivCloud Companion native host",
  "path": "$COMPANION_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$CHROME_EXTENSION_ID/"
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
  "allowed_extensions": [
    "companion@privcloud.fr"
  ]
}
EOF
  fi
  chmod 0644 "$target"
}

if [ "$(id -u)" = "0" ]; then
  install_manifest "/etc/opt/chrome/native-messaging-hosts/$HOST_NAME.json" chrome
  install_manifest "/etc/chromium/native-messaging-hosts/$HOST_NAME.json" chrome
  install_manifest "/usr/lib/mozilla/native-messaging-hosts/$HOST_NAME.json" firefox
else
  install_manifest "$HOME/.config/google-chrome/NativeMessagingHosts/$HOST_NAME.json" chrome
  install_manifest "$HOME/.config/chromium/NativeMessagingHosts/$HOST_NAME.json" chrome
  install_manifest "$HOME/.mozilla/native-messaging-hosts/$HOST_NAME.json" firefox
fi

echo "PrivCloud Companion native messaging host registered."
