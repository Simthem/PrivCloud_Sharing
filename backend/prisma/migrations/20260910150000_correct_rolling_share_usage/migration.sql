-- The public edition has no immutable quota ledger. Rebuild the visible
-- rolling window from surviving Share rows and, importantly, exclude shares
-- older than 30 days instead of reporting the whole active inventory.
UPDATE "UsageSnapshot"
SET
    "totalShares" = (
        SELECT COUNT(*)
        FROM "Share"
        WHERE "createdAt" > datetime('now', '-30 days')
          AND "createdAt" < datetime("UsageSnapshot"."day", '+1 day')
    ),
    "backfilled" = CASE
        WHEN "day" < date('now') THEN true
        ELSE "backfilled"
    END
WHERE "day" >= date('now', '-29 days')
  AND "day" <= date('now');
