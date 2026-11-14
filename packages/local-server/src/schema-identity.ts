import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { CHDB_VERSION } from "./version"

/**
 * Local-store schema version.
 *
 * Version 0 is the fingerprint-only legacy store represented by the recovery
 * procedure from issue #297. Any future structural DDL change must increment
 * this value and add a registered migration or an explicit unsupported edge.
 */
export { LOCAL_SCHEMA_VERSION }
export const LEGACY_LOCAL_SCHEMA_VERSION = 0 as const

export const LEGACY_SCHEMA_FINGERPRINT = "428701854f9fd30e"

/** v11's generated revision, which every later history entry carries forward. */
export const CURRENT_SCHEMA_PROJECT_REVISION =
	"ed74788ef292834069e0ea6ee3b22d68fc604fb66cb54d2d551db67ce8d20b3a"
export const LOCAL_SCHEMA_SQL = schemaSql
export const SCHEMA_FINGERPRINT = fingerprintSchema(schemaSql)
export const SCHEMA_DIGEST = digestSchema(schemaSql)
export const LOCAL_SCHEMA_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaSql)
export const LOCAL_SCHEMA_MANIFEST_DIGEST = LOCAL_SCHEMA_MANIFEST.digest

export interface LocalSchemaIdentity {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest?: string
	readonly chdb: string
	readonly projectRevision?: string
}

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
	projectRevision: "d58ce4a83d3ad3f3a29b9bb972272b757547ae793c050194354454634f3abccd",
}

export const identityLabel = (identity: Pick<LocalSchemaIdentity, "version" | "fingerprint">): string =>
	`v${identity.version} (${identity.fingerprint})`
