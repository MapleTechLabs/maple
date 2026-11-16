-- metadata
ALTER TABLE "dependency_scans" ADD COLUMN IF NOT EXISTS "advisory_fingerprint" text;
