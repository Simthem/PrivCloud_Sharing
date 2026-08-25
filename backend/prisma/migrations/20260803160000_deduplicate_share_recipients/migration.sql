-- Keep the oldest spelling while removing case-insensitive duplicates.
DELETE FROM "ShareRecipient"
WHERE "id" NOT IN (
  SELECT MIN("id")
  FROM "ShareRecipient"
  GROUP BY "shareId", lower(trim("email"))
);

CREATE UNIQUE INDEX "ShareRecipient_shareId_email_key"
ON "ShareRecipient"("shareId", "email");
