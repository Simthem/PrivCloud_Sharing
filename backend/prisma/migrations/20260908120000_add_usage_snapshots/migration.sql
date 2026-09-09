-- Daily platform usage history for the administration chart.
-- Retention jobs purge shares and files, so this table is the only place the
-- past can be read from: it is written forward, never reconstructed.
CREATE TABLE "UsageSnapshot" (
    "day" TEXT NOT NULL PRIMARY KEY,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalUsers" INTEGER NOT NULL,
    "totalShares" INTEGER NOT NULL,
    "totalStorageBytes" TEXT NOT NULL
);
