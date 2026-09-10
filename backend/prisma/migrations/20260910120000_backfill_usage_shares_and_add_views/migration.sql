-- Add the fourth platform metric without fabricating historical view dates.
-- Existing snapshots remain NULL because Share.views is only a cumulative
-- counter; from this deployment onward the daily job records an exact total.
ALTER TABLE "UsageSnapshot" ADD COLUMN "totalViews" INTEGER;
ALTER TABLE "UsageSnapshot" ADD COLUMN "backfilled" BOOLEAN NOT NULL DEFAULT false;

-- Rebuild the last 30 UTC calendar days from records that still exist. This
-- restores shares created before UsageSnapshot was introduced. Rows are marked
-- as backfilled so the chart presents them as estimates rather than snapshots
-- that were genuinely captured on those dates.
WITH RECURSIVE "days"("day") AS (
    SELECT date('now', '-29 days')
    UNION ALL
    SELECT date("day", '+1 day')
    FROM "days"
    WHERE "day" < date('now')
)
INSERT OR IGNORE INTO "UsageSnapshot" (
    "day",
    "capturedAt",
    "totalUsers",
    "totalShares",
    "totalViews",
    "totalStorageBytes",
    "backfilled"
)
SELECT
    "days"."day",
    CURRENT_TIMESTAMP,
    (
        SELECT COUNT(*)
        FROM "User"
        WHERE "createdAt" < datetime("days"."day", '+1 day')
    ),
    (
        SELECT COUNT(*)
        FROM "Share"
        WHERE "createdAt" < datetime("days"."day", '+1 day')
    ),
    CASE
        WHEN "days"."day" = date('now')
        THEN (SELECT COALESCE(SUM("views"), 0) FROM "Share")
        ELSE NULL
    END,
    CAST(COALESCE((
        SELECT SUM(
            CASE
                WHEN "size" GLOB '[0-9]*' AND "size" NOT GLOB '*[^0-9]*'
                THEN CAST("size" AS INTEGER)
                ELSE 0
            END
        )
        FROM "File"
        WHERE "createdAt" < datetime("days"."day", '+1 day')
    ), 0) AS TEXT),
    true
FROM "days";

-- The current row may already exist from a dashboard read earlier today.
UPDATE "UsageSnapshot"
SET "totalViews" = (SELECT COALESCE(SUM("views"), 0) FROM "Share")
WHERE "day" = date('now');
