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

# backend/data est un volume monté : toujours ajuster l'ownership
mkdir -p /opt/app/backend/data
find /opt/app/backend/data \( ! -group "${PGID}" -o ! -user "${PUID}" \) -exec chown "${PUID}:${PGID}" {} +

# Si PUID/PGID différent du build-time (1000:1000), ajuster toute l'app
# Les fichiers statiques (frontend/public, backend/dist, etc.) sont déjà
# ownés par 1000:1000 au build-time (RUN chown dans le Dockerfile).
if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
    echo "Custom PUID/PGID detected ($PUID:$PGID), adjusting ownership..."
    find /opt/app \( ! -group "${PGID}" -o ! -user "${PUID}" \) -exec chown "${PUID}:${PGID}" {} +
    chown -R "${PUID}:${PGID}" /tmp/img
fi

# Switch to the non-root user
exec gosu "$PUID:$PGID" "$@"