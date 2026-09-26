import schemaSql from "./schema/local-schema.sql" with { type: "text" }
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
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"
import { CHDB_VERSION } from "../version"

export { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"

/**
 * Local-store schema version.
 *
 * Version 0 is the fingerprint-only legacy store represented by the recovery
 * procedure from issue #297. Any future structural DDL change must increment
 * this value and add a registered migration or an explicit unsupported edge.
 */
export { LOCAL_SCHEMA_VERSION }
export const LEGACY_LOCAL_SCHEMA_VERSION = 0 as const

export const LEGACY_SCHEMA_PROJECT_REVISION =
	"d58ce4a83d3ad3f3a29b9bb972272b757547ae793c050194354454634f3abccd"
export const LEGACY_SCHEMA_FINGERPRINT = "428701854f9fd30e"

export const CURRENT_SCHEMA_PROJECT_REVISION =
	"ed74788ef292834069e0ea6ee3b22d68fc604fb66cb54d2d551db67ce8d20b3a"
/** Revision recorded by the issue-297 recovery report. The refreshed upstream
 * generator currently emits CURRENT_SCHEMA_PROJECT_REVISION; the structural
 * fingerprint is the compatibility identity used by the migration. */
export const ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION =
	"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91"
export const LOCAL_SCHEMA_SQL = schemaSql
export const SCHEMA_FINGERPRINT = fingerprintSchema(schemaSql)
export const SCHEMA_DIGEST = digestSchema(schemaSql)
export const LOCAL_SCHEMA_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaSql)
export const LOCAL_SCHEMA_MANIFEST_DIGEST = LOCAL_SCHEMA_MANIFEST.digest
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
// table-driven steps look their versions up through the two functions here.
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

export interface LocalSchemaIdentity {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest?: string
	readonly chdb: string
	readonly projectRevision?: string
}

/**
 * Per-version identities, frozen and read straight from the append-only
 * history. Historical migration edges must never point at
 * CURRENT_LOCAL_SCHEMA: when v10 ships, v0 -> v1 must still construct and verify
 * v1 rather than silently changing its destination.
 */
export const localSchemaIdentity = (version: number): LocalSchemaIdentity => {
	const entry = LOCAL_SCHEMA_HISTORY[version]
	if (!entry || entry.version !== version)
		throw new Error(`local schema history has no entry for version ${version}`)
	return Object.freeze({
		version: entry.version,
		fingerprint: entry.fingerprint,
		digest: entry.digest,
		manifestDigest: entry.manifestDigest,
		chdb: CHDB_VERSION,
		projectRevision: entry.projectRevision,
	})
}

export const LOCAL_SCHEMA_V1 = localSchemaIdentity(1)
export const LOCAL_SCHEMA_V2 = localSchemaIdentity(2)
export const LOCAL_SCHEMA_V3 = localSchemaIdentity(3)
export const LOCAL_SCHEMA_V4 = localSchemaIdentity(4)
export const LOCAL_SCHEMA_V5 = localSchemaIdentity(5)
export const LOCAL_SCHEMA_V6 = localSchemaIdentity(6)
export const LOCAL_SCHEMA_V10 = localSchemaIdentity(10)
export const LOCAL_SCHEMA_V11 = localSchemaIdentity(11)
export const LOCAL_SCHEMA_V20 = localSchemaIdentity(20)
export const LOCAL_SCHEMA_V21 = localSchemaIdentity(21)
export const LOCAL_SCHEMA_V22 = localSchemaIdentity(22)

export const CURRENT_LOCAL_SCHEMA: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_VERSION,
	fingerprint: SCHEMA_FINGERPRINT,
	digest: SCHEMA_DIGEST,
	manifestDigest: LOCAL_SCHEMA_MANIFEST_DIGEST,
	chdb: CHDB_VERSION,
	projectRevision: CURRENT_SCHEMA_PROJECT_REVISION,
})

export const LEGACY_LOCAL_SCHEMA: LocalSchemaIdentity = {
	version: LEGACY_LOCAL_SCHEMA_VERSION,
	fingerprint: LEGACY_SCHEMA_FINGERPRINT,
	digest: "",
	chdb: CHDB_VERSION,
	projectRevision: LEGACY_SCHEMA_PROJECT_REVISION,
}

export const identityLabel = (identity: Pick<LocalSchemaIdentity, "version" | "fingerprint">): string =>
	`v${identity.version} (${identity.fingerprint})`
