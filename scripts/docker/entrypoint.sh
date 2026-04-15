#!/bin/sh
set -eu

# Copy default logo to the frontend public folder if it doesn't exist
cp -rn /tmp/img/* /opt/app/frontend/public/img

if [ "${CADDY_DISABLED:-}" != "true" ]; then
    # Start Caddy
    echo "Starting Caddy..."
    if [ "${TRUST_PROXY:-}" = "true" ]; then
        caddy start --adapter caddyfile --config /opt/app/reverse-proxy/Caddyfile.trust-proxy &
    else
        caddy start --adapter caddyfile --config /opt/app/reverse-proxy/Caddyfile &
    fi
else
    echo "Caddy is disabled. Skipping..."
fi

# Run the frontend server
PORT=3333 HOSTNAME=0.0.0.0 node frontend/server.js &

# Run the backend server
cd backend

# npm run prod adds node_modules/.bin to PATH; replicate that here
# so prisma cli is found when we call it directly.
export PATH="$PWD/node_modules/.bin:$PATH"

# -- DB Diagnostics ----------------------------------------------
# Log database file state before and after each Prisma operation
# to detect path mismatches or silent data loss across redeploys.
DB_DIR="./data"
DB_FILE="$DB_DIR/pingvin-share.db"
DB_WAL="$DB_FILE-wal"
DB_SHM="$DB_FILE-shm"

_db_diag() {
    _label="$1"
    echo "=== DB DIAG [$_label] ==="
    echo "  cwd     : $(pwd)"
    if [ -f "$DB_FILE" ]; then
        _size=$(wc -c < "$DB_FILE")
        _inode=$(ls -i "$DB_FILE" | awk '{print $1}')
        echo "  db      : $_size bytes  inode=$_inode"
    else
        echo "  db      : MISSING"
    fi
    [ -f "$DB_WAL" ] && echo "  wal     : $(wc -c < "$DB_WAL") bytes" || echo "  wal     : absent"
    [ -f "$DB_SHM" ] && echo "  shm     : $(wc -c < "$DB_SHM") bytes" || echo "  shm     : absent"
    # Quick sanity: count rows in User and ReverseShare if DB exists
    if [ -f "$DB_FILE" ] && command -v node > /dev/null 2>&1; then
        node -e "
try {
  var db = new (require('better-sqlite3'))('$DB_FILE', { readonly: true });
  var users = db.prepare('SELECT count(*) AS c FROM User').get();
  var rs = db.prepare('SELECT count(*) AS c FROM ReverseShare').get();
  var hasKey = db.prepare('SELECT count(*) AS c FROM User WHERE encryptionKeyHash IS NOT NULL').get();
  console.log('  users   :', users.c, '(with E2E key:', hasKey.c + ')');
  console.log('  revShare:', rs.c);
  db.close();
} catch(e) { console.log('  query   : skip (' + e.message.slice(0,80) + ')'); }
" 2>/dev/null || true
    fi
    echo "=== END DIAG [$_label] ==="
}

_db_diag "before-migrate"
prisma migrate deploy
_db_diag "after-migrate"
prisma db seed
_db_diag "after-seed"

node dist/src/main

# Wait for all processes to finish
wait