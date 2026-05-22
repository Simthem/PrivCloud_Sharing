-- CreateTable: FileAccess (per-file permission overrides)
CREATE TABLE IF NOT EXISTS "FileAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "permission" TEXT NOT NULL DEFAULT 'READ',
    "canRequestSignature" BOOLEAN NOT NULL DEFAULT false,
    "memberId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "FileAccess_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileAccess_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "FileAccess_memberId_fileId_key" ON "FileAccess"("memberId", "fileId");

-- AlterTable: add canRequestSignature to TeamFolderAccess only if not already present.
-- SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we use a
-- workaround: attempt the ALTER and ignore SQLITE_ERROR (duplicate column) via
-- the application layer. The entrypoint.sh reconcile script handles the case
-- where this migration is marked as failed because the column already existed.
-- On a fresh database this runs cleanly.
ALTER TABLE "TeamFolderAccess" ADD COLUMN "canRequestSignature" BOOLEAN NOT NULL DEFAULT false;
