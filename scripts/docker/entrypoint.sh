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
# NODE_OPTIONS='' : clear any inherited NODE_OPTIONS to prevent global-agent
# from routing localhost SSR calls through the forward proxy.
NODE_OPTIONS='' PORT=3333 HOSTNAME=0.0.0.0 node frontend/server.js &

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
        _inode=$(stat -c '%i' "$DB_FILE")
        echo "  db      : $_size bytes  inode=$_inode"
    else
        echo "  db      : MISSING"
    fi
    [ -f "$DB_WAL" ] && echo "  wal     : $(wc -c < "$DB_WAL") bytes" || echo "  wal     : absent"
    [ -f "$DB_SHM" ] && echo "  shm     : $(wc -c < "$DB_SHM") bytes" || echo "  shm     : absent"
    # Quick sanity: count rows in User and ReverseShare if DB exists
    if [ -f "$DB_FILE" ] && command -v node > /dev/null 2>&1; then
        NODE_OPTIONS='' node -e "
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

# Reconcile _prisma_migrations with the actual DB state when schema was
# previously synced via 'prisma db push' (no migration record written).
#
# Two cases handled for each managed migration:
#   1. Migration record missing but schema is already correct
#      -> INSERT the record as successfully applied
#   2. Migration record present but marked as FAILED (finished_at IS NULL)
#      and schema is already correct
#      -> UPDATE the record to mark it as resolved
#
# This avoids both P3005 (schema ahead of migrations) and P3009 (failed migration).
if [ -f "$DB_FILE" ] && command -v node > /dev/null 2>&1; then
    NODE_OPTIONS='' node -e "
try {
  var db = new (require('better-sqlite3'))('$DB_FILE');
  var crypto = require('crypto');

  var hasMigTable = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'\").get();
  if (!hasMigTable) { db.close(); process.exit(0); }

  function colExists(table, col) {
    try { return !!db.prepare('SELECT name FROM pragma_table_info(\"' + table + '\") WHERE name = ?').get(col); }
    catch(e) { return false; }
  }
  function tableExists(name) {
    try { return !!db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name=?\").get(name); }
    catch(e) { return false; }
  }

  // -- Abandoned migration cleanup -------------------------------------------
  // 20260522150000_remove_saas_fields was removed from the repository because
  // it operated on tables that no longer existed at run time (Subscription had
  // already been dropped by 20260512125117, Team did not yet exist). Any prod
  // DB that attempted to upgrade will have this record stuck as FAILED, which
  // causes P3009 on the next 'prisma migrate deploy'. Mark it as rolled-back so
  // that Prisma can continue. Completely non-destructive: no user data is touched.
  var abandonedMig = '20260522150000_remove_saas_fields';
  var abandonedRow = db.prepare('SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?').get(abandonedMig);
  if (abandonedRow && !abandonedRow.finished_at && !abandonedRow.rolled_back_at) {
    console.log('[entrypoint] ' + abandonedMig + ': found as failed, marking as rolled-back (migration removed from repository)');
    db.prepare('UPDATE _prisma_migrations SET rolled_back_at = datetime(\'now\'), logs = \'Migration removed from repository: operated on tables that no longer existed at migration time.\' WHERE id = ?')
      .run(abandonedRow.id);
  }

  // List of migrations to reconcile: [name, fn_that_returns_true_if_schema_ok]
  var migrations = [
    ['20260716140000_add_folder_access_granular_perms', function() {
      return colExists('TeamFolderAccess', 'canDownload') && colExists('TeamFolderAccess', 'canDelete');
    }],
    ['20260716150000_add_file_access_and_signature_perms', function() {
      return tableExists('FileAccess') && colExists('TeamFolderAccess', 'canRequestSignature');
    }],
    ['20260716120000_add_member_feature_permissions', function() {
      return colExists('TeamMember', 'canViewActivity') && colExists('TeamMember', 'canViewSignatures');
    }],
  ];

  migrations.forEach(function(entry) {
    var migName = entry[0];
    var schemaOk = entry[1];
    var row = db.prepare('SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?').get(migName);
    if (!row) {
      if (schemaOk()) {
        console.log('[entrypoint] ' + migName + ': schema ok, no record -> marking as applied');
        db.prepare('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (?, ?, datetime(\"now\"), ?, NULL, NULL, datetime(\"now\"), 1)')
          .run(crypto.randomUUID(), '', migName);
      }
    } else if (!row.finished_at && !row.rolled_back_at) {
      if (schemaOk()) {
        console.log('[entrypoint] ' + migName + ': schema ok, migration failed -> resolving');
        db.prepare('UPDATE _prisma_migrations SET finished_at = datetime(\"now\"), logs = NULL, applied_steps_count = 1 WHERE id = ?')
          .run(row.id);
      } else {
        console.log('[entrypoint] ' + migName + ': migration failed and schema incomplete - will retry');
      }
    }
  });

  db.close();
} catch(e) { console.log('[entrypoint] migration-reconcile error: ' + e.message.slice(0,200)); }
" 2>/dev/null || true
fi

prisma migrate deploy
_db_diag "after-migrate"
prisma db seed
_db_diag "after-seed"

# Load global-agent ONLY for the backend process.
# global-agent patches http.request()/https.request() to honor HTTP_PROXY,
# which is required by AWS SDK v3 S3Client (NodeHttpHandler).
# main.ts additionally patches globalThis.fetch() via undici ProxyAgent
# for OAuth/hCaptcha calls.
#
# Express buffers entire raw bodies in RAM. Tune NODE_MAX_OLD_SPACE_SIZE
# together with UPLOAD_MAX_CHUNK_BYTES and the container mem_limit.
NODE_MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-3072}"
NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE} --require ./node_modules/global-agent/bootstrap" node dist/src/main

# Wait for all processes to finish
wait
