-- AlterTable
ALTER TABLE "OAuthUser" ADD COLUMN "verifiedEmailFold" TEXT;

-- CreateIndex
CREATE INDEX "OAuthUser_verifiedEmailFold_idx" ON "OAuthUser"("verifiedEmailFold");
