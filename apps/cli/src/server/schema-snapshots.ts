import schemaV1Sql from "./schema/local-schema-v1.sql" with { type: "text" }
import schemaV2Sql from "./schema/local-schema-v2.sql" with { type: "text" }
import schemaV3Sql from "./schema/local-schema-v3.sql" with { type: "text" }
import schemaV4Sql from "./schema/local-schema-v4.sql" with { type: "text" }
import schemaV5Sql from "./schema/local-schema-v5.sql" with { type: "text" }
import schemaV6Sql from "./schema/local-schema-v6.sql" with { type: "text" }
import schemaV7Sql from "./schema/local-schema-v7.sql" with { type: "text" }
import schemaV8Sql from "./schema/local-schema-v8.sql" with { type: "text" }
import schemaV9Sql from "./schema/local-schema-v9.sql" with { type: "text" }
import schemaV10Sql from "./schema/local-schema-v10.sql" with { type: "text" }
import schemaV11Sql from "./schema/local-schema-v11.sql" with { type: "text" }
import schemaV12Sql from "./schema/local-schema-v12.sql" with { type: "text" }
import schemaV13Sql from "./schema/local-schema-v13.sql" with { type: "text" }
import schemaV14Sql from "./schema/local-schema-v14.sql" with { type: "text" }
import schemaV15Sql from "./schema/local-schema-v15.sql" with { type: "text" }
import schemaV16Sql from "./schema/local-schema-v16.sql" with { type: "text" }
import schemaV17Sql from "./schema/local-schema-v17.sql" with { type: "text" }
import schemaV18Sql from "./schema/local-schema-v18.sql" with { type: "text" }
import schemaV19Sql from "./schema/local-schema-v19.sql" with { type: "text" }
import schemaV20Sql from "./schema/local-schema-v20.sql" with { type: "text" }
import schemaV21Sql from "./schema/local-schema-v21.sql" with { type: "text" }
import schemaV22Sql from "./schema/local-schema-v22.sql" with { type: "text" }
import schemaV23Sql from "./schema/local-schema-v23.sql" with { type: "text" }
import schemaV24Sql from "./schema/local-schema-v24.sql" with { type: "text" }
import schemaV25Sql from "./schema/local-schema-v25.sql" with { type: "text" }
import schemaV26Sql from "./schema/local-schema-v26.sql" with { type: "text" }
import schemaV27Sql from "./schema/local-schema-v27.sql" with { type: "text" }
import schemaV28Sql from "./schema/local-schema-v28.sql" with { type: "text" }
import schemaV29Sql from "./schema/local-schema-v29.sql" with { type: "text" }
import schemaV30Sql from "./schema/local-schema-v30.sql" with { type: "text" }
import schemaV31Sql from "./schema/local-schema-v31.sql" with { type: "text" }
import schemaV32Sql from "./schema/local-schema-v32.sql" with { type: "text" }
import schemaV33Sql from "./schema/local-schema-v33.sql" with { type: "text" }
import schemaV34Sql from "./schema/local-schema-v34.sql" with { type: "text" }
import schemaV35Sql from "./schema/local-schema-v35.sql" with { type: "text" }
import schemaV36Sql from "./schema/local-schema-v36.sql" with { type: "text" }
import schemaV37Sql from "./schema/local-schema-v37.sql" with { type: "text" }
import schemaV38Sql from "./schema/local-schema-v38.sql" with { type: "text" }
import schemaV39Sql from "./schema/local-schema-v39.sql" with { type: "text" }
import schemaV40Sql from "./schema/local-schema-v40.sql" with { type: "text" }
import schemaV41Sql from "./schema/local-schema-v41.sql" with { type: "text" }
import schemaV42Sql from "./schema/local-schema-v42.sql" with { type: "text" }
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "@maple/local-server/schema-manifest"

/**
 * Immutable per-version DDL and manifest snapshots.
 *
 * A historical edge must keep constructing and verifying the schema it was
 * written for: when v10 ships, v8 -> v9 must still produce v9 rather than
 * silently retargeting whatever the generator currently emits. The SQL is
 * imported literally because Bun resolves text imports statically; everything
 * derived from it is built once, here.
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
]

export interface LocalSchemaSnapshot {
	readonly version: number
	readonly sql: string
	readonly manifest: LocalSchemaManifest
	readonly manifestDigest: string
}

/** Indexed by schema version; index 0 is the fingerprint-only legacy store, which has no DDL. */
export const LOCAL_SCHEMA_SNAPSHOTS: ReadonlyArray<LocalSchemaSnapshot | undefined> = Object.freeze([
	undefined,
	...SNAPSHOT_SQL.map((sql, index) => {
		const manifest = buildLocalSchemaManifest(sql)
		return Object.freeze({ version: index + 1, sql, manifest, manifestDigest: manifest.digest })
	}),
])

/** The frozen DDL and manifest a migration step builds and verifies for `version`. */
export const localSchemaSnapshot = (version: number): LocalSchemaSnapshot => {
	const snapshot = LOCAL_SCHEMA_SNAPSHOTS[version]
	if (!snapshot) throw new Error(`no bundled DDL snapshot for local schema version ${version}`)
	return snapshot
}

// Per-version constants exist only where the legacy step or the tests pin them;
// table-driven steps look their versions up through localSchemaSnapshot and localSchemaIdentity.
export const LOCAL_SCHEMA_V1_SQL = localSchemaSnapshot(1).sql
export const LOCAL_SCHEMA_V1_MANIFEST = localSchemaSnapshot(1).manifest
export const LOCAL_SCHEMA_V2_MANIFEST = localSchemaSnapshot(2).manifest
export const LOCAL_SCHEMA_V3_MANIFEST = localSchemaSnapshot(3).manifest
export const LOCAL_SCHEMA_V4_MANIFEST = localSchemaSnapshot(4).manifest
export const LOCAL_SCHEMA_V5_MANIFEST = localSchemaSnapshot(5).manifest
export const LOCAL_SCHEMA_V7_MANIFEST = localSchemaSnapshot(7).manifest
export const LOCAL_SCHEMA_V10_MANIFEST = localSchemaSnapshot(10).manifest
export const LOCAL_SCHEMA_V11_MANIFEST = localSchemaSnapshot(11).manifest
export const LOCAL_SCHEMA_V12_MANIFEST = localSchemaSnapshot(12).manifest
export const LOCAL_SCHEMA_V13_MANIFEST = localSchemaSnapshot(13).manifest
