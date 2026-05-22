-- Add signing display options to SignatureDocument
ALTER TABLE "SignatureDocument" ADD COLUMN "addApprovalMention" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SignatureDocument" ADD COLUMN "addInitials" BOOLEAN NOT NULL DEFAULT false;
