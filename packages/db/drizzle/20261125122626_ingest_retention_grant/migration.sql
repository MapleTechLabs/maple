-- The ingest gateway reads an org's retention policy with each key and connector lookup, to
-- stamp rows with how long their source keeps them (`INGEST_GATEWAY_GRANTS`, roles.ts). Its
-- grant on `sources` is table-wide, so `sources.retention_days` needs none.
GRANT SELECT ON TABLE org_retention_policies TO maple_ingest;
