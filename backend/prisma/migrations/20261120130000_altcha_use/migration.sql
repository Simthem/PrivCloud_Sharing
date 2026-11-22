-- ALTCHA challenges already solved, shared by every backend instance.
CREATE TABLE "AltchaUse" (
    "challengeId" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
);

CREATE INDEX "AltchaUse_expiresAt_idx" ON "AltchaUse"("expiresAt");
