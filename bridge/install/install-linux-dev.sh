#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

if [ -z "${PRIVCLOUD_BASE_URL:-}" ]; then
  echo "PRIVCLOUD_BASE_URL must contain the URL of your PrivCloud instance." >&2
  echo "Example: curl -fsSL https://share.example/install/companion/install/install-linux-dev.sh | PRIVCLOUD_BASE_URL=https://share.example sh" >&2
  exit 1
fi

# Canonicalize the origin and reject paths, credentials and unsafe remote HTTP.
BASE_URL="$(node - "$PRIVCLOUD_BASE_URL" <<'NODE'
const raw = process.argv[2];
let url;
try {
  url = new URL(raw);
} catch {
  console.error("PRIVCLOUD_BASE_URL is not a valid absolute URL.");
  process.exit(1);
}
const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
  console.error("Use HTTPS (HTTP is accepted only for a loopback development instance).");
  process.exit(1);
}
if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  console.error("PRIVCLOUD_BASE_URL must be an origin without credentials, path, query or fragment.");
  process.exit(1);
}
process.stdout.write(url.origin);
NODE
)"

APP_DIR="$HOME/.local/share/privcloud-companion"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/privcloud-companion"
DESKTOP_DIR="$HOME/.config/autostart"
DESKTOP_FILE="$DESKTOP_DIR/privcloud-companion.desktop"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_DIR/privcloud-companion.service"
STATE_DIR="$HOME/.privcloud-bridge"
# Keep the final .mjs extension: Node.js 24 resolves the module format before
# running --check and rejects generic .tmp files as unknown modules.
SOURCE_TMP="$APP_DIR/privcloud-companion.tmp.mjs"

mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$SYSTEMD_DIR" "$STATE_DIR"
chmod 0700 "$STATE_DIR"
trap 'rm -f "$SOURCE_TMP"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/install/companion/privcloud-companion.mjs" \
  -o "$SOURCE_TMP"
node --check "$SOURCE_TMP"
chmod 0755 "$SOURCE_TMP"
mv "$SOURCE_TMP" "$APP_DIR/privcloud-companion.mjs"

cat > "$BIN_PATH" <<EOF
#!/bin/sh
export PRIVCLOUD_BRIDGE_ORIGINS='$BASE_URL'
export PRIVCLOUD_COMPANION_NATIVE_ORIGINS='$BASE_URL'
exec node '$APP_DIR/privcloud-companion.mjs' "\$@"
EOF
chmod 0755 "$BIN_PATH"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=PrivCloud Companion
Exec="$BIN_PATH"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
chmod 0644 "$DESKTOP_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PrivCloud Companion local bridge
After=network-online.target

[Service]
Type=simple
ExecStart="$BIN_PATH"
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$STATE_DIR"
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
EOF
chmod 0644 "$SERVICE_FILE"

curl -fsSL "$BASE_URL/install/companion/install/linux/register-native-messaging.sh" \
  -o "$APP_DIR/register-native-messaging.sh"
chmod 0755 "$APP_DIR/register-native-messaging.sh"
PRIVCLOUD_COMPANION_PATH="$BIN_PATH" "$APP_DIR/register-native-messaging.sh"

if command -v pkill >/dev/null 2>&1; then
  pkill -f "$APP_DIR/privcloud-companion.mjs" >/dev/null 2>&1 || true
fi

if command -v systemctl >/dev/null 2>&1 && \
  systemctl --user daemon-reload >/dev/null 2>&1; then
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=PrivCloud Companion
Exec="$BIN_PATH"
Terminal=false
X-GNOME-Autostart-enabled=false
Hidden=true
EOF
  chmod 0644 "$DESKTOP_FILE"
  systemctl --user enable privcloud-companion.service
  systemctl --user restart privcloud-companion.service
elif command -v nohup >/dev/null 2>&1; then
  nohup "$BIN_PATH" >/dev/null 2>&1 &
fi

echo "PrivCloud Companion installed for $BASE_URL."
echo "The local service accepts requests only from this configured instance."
