#!/bin/sh
set -eu

HOST_NAME="fr.privcloud.companion"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$SCRIPT_DIR/privcloud-companion" ]; then
  DEFAULT_COMPANION_PATH="$SCRIPT_DIR/privcloud-companion"
else
  DEFAULT_COMPANION_PATH="/usr/bin/privcloud-companion"
fi
COMPANION_PATH="${PRIVCLOUD_COMPANION_PATH:-$DEFAULT_COMPANION_PATH}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
case "$COMPANION_PATH" in
  /*) ;;
  *) echo "Companion path must be absolute." >&2; exit 1 ;;
esac
# Paths are inserted into JSON manifests and must not alter their structure.
if printf '%s' "$COMPANION_PATH" | LC_ALL=C grep -q '["\\[:cntrl:]]'; then
  echo "Companion path contains unsupported JSON characters." >&2
  exit 1
fi
CHROME_EXTENSION_ID="${PRIVCLOUD_CHROME_EXTENSION_ID:-}"
if [ -n "$CHROME_EXTENSION_ID" ]; then
  case "$CHROME_EXTENSION_ID" in
    *[!a-p]*) echo "Chrome extension ID must contain only letters a-p." >&2; exit 1 ;;
  esac
  if [ "${#CHROME_EXTENSION_ID}" -ne 32 ]; then
    echo "Chrome extension ID must contain exactly 32 letters." >&2
    exit 1
  fi
fi

if [ ! -x "$COMPANION_PATH" ]; then
  echo "PrivCloud Companion binary not found or not executable: $COMPANION_PATH" >&2
  exit 1
fi

install_manifest() {
  target="$1"
  kind="$2"
  case "$COMPANION_PATH" in
    *'
'*) echo "Companion path contains a line break." >&2; exit 1 ;;
  esac
  if printf '%s' "$COMPANION_PATH" | LC_ALL=C grep -q '["\\[:cntrl:]]'; then
    echo "Companion path contains unsupported JSON characters." >&2
    exit 1
  fi
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
  if [ -n "$CHROME_EXTENSION_ID" ]; then
    install_manifest "/etc/opt/chrome/native-messaging-hosts/$HOST_NAME.json" chrome
    install_manifest "/etc/chromium/native-messaging-hosts/$HOST_NAME.json" chrome
  fi
  install_manifest "/usr/lib/mozilla/native-messaging-hosts/$HOST_NAME.json" firefox
else
  if [ -n "$CHROME_EXTENSION_ID" ]; then
    install_manifest "$CONFIG_HOME/google-chrome/NativeMessagingHosts/$HOST_NAME.json" chrome
    install_manifest "$CONFIG_HOME/chromium/NativeMessagingHosts/$HOST_NAME.json" chrome
    # Flatpak uses its own XDG_CONFIG_HOME. Run inside its existing sandbox,
    # using the same user-owned host and Node runtime; no host-spawn override.
    for flatpak_app in org.chromium.Chromium com.google.Chrome com.brave.Browser; do
      flatpak_root="$HOME/.var/app/$flatpak_app"
      [ -d "$flatpak_root" ] || continue
      case "$flatpak_app" in
        org.chromium.Chromium) flatpak_profile="chromium" ;;
        com.google.Chrome) flatpak_profile="google-chrome" ;;
        com.brave.Browser) flatpak_profile="BraveSoftware/Brave-Browser" ;;
      esac
      saved_path="$COMPANION_PATH"
      if [ "$COMPANION_PATH" = "/usr/bin/privcloud-companion" ]; then
        # /opt and /usr/bin belong to the Flatpak runtime, not the host OS.
        # Copy the dependency-free payload into the already visible user home.
        payload="/opt/privcloud-companion"
        digest=$(sha256sum "$payload/privcloud-companion.mjs" "$payload/native-transport.mjs" "$payload/direct-upload.mjs" "$COMPANION_PATH" | sha256sum)
        digest=${digest%% *}
        package_dir="$HOME/.local/share/privcloud-companion/packages/$digest"
        mkdir -p "$package_dir"
        chmod 0700 "$package_dir"
        cp "$payload/privcloud-companion.mjs" "$payload/native-transport.mjs" "$payload/direct-upload.mjs" "$package_dir/"
        cp "$COMPANION_PATH" "$package_dir/privcloud-companion"
        chmod 0700 "$package_dir/privcloud-companion"
        COMPANION_PATH="$package_dir/privcloud-companion"
      fi
      install_manifest "$flatpak_root/config/$flatpak_profile/NativeMessagingHosts/$HOST_NAME.json" chrome
      echo "Native host registered for Flatpak $flatpak_app (existing permissions retained)." >&2
      COMPANION_PATH="$saved_path"
    done
  fi
  install_manifest "$HOME/.mozilla/native-messaging-hosts/$HOST_NAME.json" firefox
fi

if [ -z "$CHROME_EXTENSION_ID" ]; then
  echo "Firefox native host registered. Chrome/Chromium: set PRIVCLOUD_CHROME_EXTENSION_ID to the exact ID from chrome://extensions and rerun this script." >&2
else
  echo "PrivCloud Companion native messaging host registered."
fi
