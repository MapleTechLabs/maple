// Local mode pins a single synthetic tenant. The Rust ingest binary writes
// every decoded span/log/metric under this `OrgId`, and every `CH.compile(...)`
// call must pass the same constant so the WHERE `OrgId = 'local'` filter matches.
export const LOCAL_ORG_ID = "local"
