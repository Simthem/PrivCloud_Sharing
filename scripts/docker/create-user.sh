#!/bin/sh
set -eu
# If we aren't running as root, just exec the CMD
[ "$(id -u)" -ne 0 ] && exec "$@"

echo "Creating user and group..."

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Check if the group with PGID exists; if not, create it
if ! getent group privcloud-sharing-group > /dev/null 2>&1; then
    groupadd -g "$PGID" privcloud-sharing-group
fi

# Check if a user with PUID exists; if not, create it
if ! id -u privcloud-sharing > /dev/null 2>&1; then
    if ! getent passwd "$PUID" > /dev/null 2>&1; then
        useradd -u "$PUID" -g privcloud-sharing-group -s /usr/sbin/nologin privcloud-sharing > /dev/null 2>&1
    else
        # If a user with the PUID already exists, use that user
        existing_user=$(getent passwd "$PUID" | cut -d: -f1)
        echo "Using existing user: $existing_user"
    fi
fi

# backend/data is a mounted volume: always adjust ownership
mkdir -p /opt/app/backend/data
find /opt/app/backend/data \( ! -group "${PGID}" -o ! -user "${PUID}" \) -exec chown "${PUID}:${PGID}" {} +

# If PUID/PGID differs from build-time (1000:1000), adjust the whole app
# Static files (frontend/public, backend/dist, etc.) are already owned
# by 1000:1000 at build-time (RUN chown in the Dockerfile).
if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
    echo "Custom PUID/PGID detected ($PUID:$PGID), adjusting ownership..."
    find /opt/app \( ! -group "${PGID}" -o ! -user "${PUID}" \) -exec chown "${PUID}:${PGID}" {} +
    chown -R "${PUID}:${PGID}" /tmp/img
fi

# Switch to the non-root user
exec gosu "$PUID:$PGID" "$@"