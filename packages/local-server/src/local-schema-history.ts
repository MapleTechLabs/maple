import schemaV1Sql from "./schema/history/local-schema-v1.sql" with { type: "text" }
import schemaV2Sql from "./schema/history/local-schema-v2.sql" with { type: "text" }
import schemaV3Sql from "./schema/history/local-schema-v3.sql" with { type: "text" }
import schemaV4Sql from "./schema/history/local-schema-v4.sql" with { type: "text" }
import schemaV5Sql from "./schema/history/local-schema-v5.sql" with { type: "text" }
import schemaV6Sql from "./schema/history/local-schema-v6.sql" with { type: "text" }
import schemaV7Sql from "./schema/history/local-schema-v7.sql" with { type: "text" }
import schemaV8Sql from "./schema/history/local-schema-v8.sql" with { type: "text" }
import schemaV9Sql from "./schema/history/local-schema-v9.sql" with { type: "text" }
import schemaV10Sql from "./schema/history/local-schema-v10.sql" with { type: "text" }
import schemaV11Sql from "./schema/history/local-schema-v11.sql" with { type: "text" }
import schemaV12Sql from "./schema/history/local-schema-v12.sql" with { type: "text" }
import schemaV13Sql from "./schema/history/local-schema-v13.sql" with { type: "text" }
import schemaV14Sql from "./schema/history/local-schema-v14.sql" with { type: "text" }
import schemaV15Sql from "./schema/history/local-schema-v15.sql" with { type: "text" }
import schemaV16Sql from "./schema/history/local-schema-v16.sql" with { type: "text" }
import schemaV17Sql from "./schema/history/local-schema-v17.sql" with { type: "text" }
import schemaV18Sql from "./schema/history/local-schema-v18.sql" with { type: "text" }
import schemaV19Sql from "./schema/history/local-schema-v19.sql" with { type: "text" }
import schemaV20Sql from "./schema/history/local-schema-v20.sql" with { type: "text" }
import schemaV21Sql from "./schema/history/local-schema-v21.sql" with { type: "text" }
import schemaV22Sql from "./schema/history/local-schema-v22.sql" with { type: "text" }
import schemaV23Sql from "./schema/history/local-schema-v23.sql" with { type: "text" }
import schemaV24Sql from "./schema/history/local-schema-v24.sql" with { type: "text" }
import schemaV25Sql from "./schema/history/local-schema-v25.sql" with { type: "text" }
import schemaV26Sql from "./schema/history/local-schema-v26.sql" with { type: "text" }
import schemaV27Sql from "./schema/history/local-schema-v27.sql" with { type: "text" }
import schemaV28Sql from "./schema/history/local-schema-v28.sql" with { type: "text" }
import schemaV29Sql from "./schema/history/local-schema-v29.sql" with { type: "text" }
import schemaV30Sql from "./schema/history/local-schema-v30.sql" with { type: "text" }
import schemaV31Sql from "./schema/history/local-schema-v31.sql" with { type: "text" }
import schemaV32Sql from "./schema/history/local-schema-v32.sql" with { type: "text" }
import schemaV33Sql from "./schema/history/local-schema-v33.sql" with { type: "text" }
import schemaV34Sql from "./schema/history/local-schema-v34.sql" with { type: "text" }
import schemaV35Sql from "./schema/history/local-schema-v35.sql" with { type: "text" }
import schemaV36Sql from "./schema/history/local-schema-v36.sql" with { type: "text" }
import schemaV37Sql from "./schema/history/local-schema-v37.sql" with { type: "text" }
import schemaV38Sql from "./schema/history/local-schema-v38.sql" with { type: "text" }
import schemaV39Sql from "./schema/history/local-schema-v39.sql" with { type: "text" }
import schemaV40Sql from "./schema/history/local-schema-v40.sql" with { type: "text" }
import schemaV41Sql from "./schema/history/local-schema-v41.sql" with { type: "text" }
import schemaV42Sql from "./schema/history/local-schema-v42.sql" with { type: "text" }
import schemaV43Sql from "./schema/history/local-schema-v43.sql" with { type: "text" }
import schemaV44Sql from "./schema/history/local-schema-v44.sql" with { type: "text" }
import schemaV45Sql from "./schema/history/local-schema-v45.sql" with { type: "text" }
import schemaV46Sql from "./schema/history/local-schema-v46.sql" with { type: "text" }
import schemaV47Sql from "./schema/history/local-schema-v47.sql" with { type: "text" }
import schemaV48Sql from "./schema/history/local-schema-v48.sql" with { type: "text" }
import schemaV49Sql from "./schema/history/local-schema-v49.sql" with { type: "text" }
import schemaV50Sql from "./schema/history/local-schema-v50.sql" with { type: "text" }
import schemaV51Sql from "./schema/history/local-schema-v51.sql" with { type: "text" }
import schemaV52Sql from "./schema/history/local-schema-v52.sql" with { type: "text" }
import schemaV53Sql from "./schema/history/local-schema-v53.sql" with { type: "text" }
import schemaV54Sql from "./schema/history/local-schema-v54.sql" with { type: "text" }
import schemaV55Sql from "./schema/history/local-schema-v55.sql" with { type: "text" }
import schemaV56Sql from "./schema/history/local-schema-v56.sql" with { type: "text" }
import { Array as Arr } from "effect"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LEGACY_LOCAL_SCHEMA, LEGACY_LOCAL_SCHEMA_VERSION, type LocalSchemaIdentity } from "./schema-identity"
import { schemaDigest, schemaFingerprint } from "./store-version"
import { CHDB_VERSION } from "./version"

/**
 * Append-only local-store schema history, derived from the frozen per-version DDL.
 *
 * Every snapshot file is immutable once shipped (the schema gate compares them to
 * the base branch byte for byte), so each version's identity is a pure function of
 * its file. `local-schema:bump` appends the next snapshot to this list.
 */
const SNAPSHOT_SQL: ReadonlyArray<string> = [
	schemaV1Sql,
	schemaV2Sql,
	schemaV3Sql,
	schemaV4Sql,
	schemaV5Sql,
	schemaV6Sql,
	schemaV7Sql,
	schemaV8Sql,
	schemaV9Sql,
	schemaV10Sql,
	schemaV11Sql,
	schemaV12Sql,
	schemaV13Sql,
	schemaV14Sql,
	schemaV15Sql,
	schemaV16Sql,
	schemaV17Sql,
	schemaV18Sql,
	schemaV19Sql,
	schemaV20Sql,
	schemaV21Sql,
	schemaV22Sql,
	schemaV23Sql,
	schemaV24Sql,
	schemaV25Sql,
	schemaV26Sql,
	schemaV27Sql,
	schemaV28Sql,
	schemaV29Sql,
	schemaV30Sql,
	schemaV31Sql,
	schemaV32Sql,
	schemaV33Sql,
	schemaV34Sql,
	schemaV35Sql,
	schemaV36Sql,
	schemaV37Sql,
	schemaV38Sql,
	schemaV39Sql,
	schemaV40Sql,
	schemaV41Sql,
	schemaV42Sql,
	schemaV43Sql,
	schemaV44Sql,
	schemaV45Sql,
	schemaV46Sql,
	schemaV47Sql,
	schemaV48Sql,
	schemaV49Sql,
	schemaV50Sql,
	schemaV51Sql,
	schemaV52Sql,
	schemaV53Sql,
	schemaV54Sql,
	schemaV55Sql,
	schemaV56Sql,
]

export interface LocalSchemaSnapshot {
	readonly version: number
	readonly sql: string
	readonly manifest: LocalSchemaManifest
	readonly manifestDigest: string
}

export interface LocalSchemaHistoryEntry {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest: string
	readonly projectRevision: string
}

/** The newest schema version with a frozen snapshot; v0 has none. */
export const LOCAL_SCHEMA_HISTORY_TIP = SNAPSHOT_SQL.length

const snapshots = new Map<number, LocalSchemaSnapshot>()

/** The frozen DDL and manifest a migration step builds and verifies for `version`, built on first use. */
export const localSchemaSnapshot = (version: number): LocalSchemaSnapshot => {
	const cached = snapshots.get(version)
	if (cached !== undefined) return cached
	const sql = Number.isInteger(version) && version >= 1 ? SNAPSHOT_SQL[version - 1] : undefined
	if (sql === undefined) throw new Error(`no bundled DDL snapshot for local schema version ${version}`)
	const manifest = buildLocalSchemaManifest(sql)
	const snapshot = Object.freeze({ version, sql, manifest, manifestDigest: manifest.digest })
	snapshots.set(version, snapshot)
	return snapshot
}

// Generated headers recorded the project revision up to v11; every later entry
// carries v11's forward, so identities already written to journals stay identical.
const LAST_RECORDED_PROJECT_REVISION = 11

const headerProjectRevision = (version: number): string => {
	const match = /^-- projectRevision: ([0-9a-f]{64})$/m.exec(localSchemaSnapshot(version).sql)
	if (match?.[1] === undefined)
		throw new Error(`local schema v${version} snapshot has no projectRevision header`)
	return match[1]
}

const LEGACY_ENTRY: LocalSchemaHistoryEntry = Object.freeze({
	version: LEGACY_LOCAL_SCHEMA_VERSION,
	fingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
	digest: LEGACY_LOCAL_SCHEMA.digest,
	manifestDigest: "",
	projectRevision: LEGACY_LOCAL_SCHEMA.projectRevision ?? "",
})

const entries = new Map<number, LocalSchemaHistoryEntry>()

const historyEntry = (version: number): LocalSchemaHistoryEntry => {
	if (version === LEGACY_LOCAL_SCHEMA_VERSION) return LEGACY_ENTRY
	const cached = entries.get(version)
	if (cached !== undefined) return cached
	const snapshot = localSchemaSnapshot(version)
	const entry = Object.freeze({
		version,
		fingerprint: schemaFingerprint(snapshot.sql),
		digest: schemaDigest(snapshot.sql),
		manifestDigest: snapshot.manifestDigest,
		projectRevision: headerProjectRevision(Math.min(version, LAST_RECORDED_PROJECT_REVISION)),
	})
	entries.set(version, entry)
	return entry
}

/** Every structural identity from v0 to the tip, indexed by version. */
export const localSchemaHistory = (): ReadonlyArray<LocalSchemaHistoryEntry> =>
	Arr.makeBy(LOCAL_SCHEMA_HISTORY_TIP + 1, historyEntry)

const identities = new Map<number, LocalSchemaIdentity>()

/**
 * The frozen identity of `version`. Historical migration edges must never point
 * at CURRENT_LOCAL_SCHEMA: when v10 ships, v0 -> v1 must still construct and
 * verify v1 rather than silently changing its destination.
 */
export const localSchemaIdentity = (version: number): LocalSchemaIdentity => {
	const cached = identities.get(version)
	if (cached !== undefined) return cached
	if (!Number.isInteger(version) || version < 0 || version > LOCAL_SCHEMA_HISTORY_TIP)
		throw new Error(`local schema history has no entry for version ${version}`)
	const entry = historyEntry(version)
	// Key order is what journals serialize; keep it.
	const identity = Object.freeze({
		version: entry.version,
		fingerprint: entry.fingerprint,
		digest: entry.digest,
		manifestDigest: entry.manifestDigest,
		chdb: CHDB_VERSION,
		projectRevision: entry.projectRevision,
	})
	identities.set(version, identity)
	return identity
}

/** Immutable SQLite control DDL identities, checked by clickhouse:schema:check. */
export const LOCAL_CONTROL_SCHEMA_HISTORY = Object.freeze([
	Object.freeze({ version: 1, digest: "9af9047b0e0e4f3562c0ee02bab4c25969960712dab862aee73eb5e8dc16b522" }),
] as const)
