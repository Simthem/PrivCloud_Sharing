-- The source file remains immutable. Signing requests can carry a per-page
-- clockwise rotation that is applied only to the signing rendition.
ALTER TABLE "SignatureDocument" ADD COLUMN "pageRotations" JSON;
