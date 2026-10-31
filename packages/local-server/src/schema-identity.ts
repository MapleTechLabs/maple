import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"
import { CHDB_VERSION } from "./version"

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
export const LOCAL_SCHEMA_V23 = localSchemaIdentity(23)
export const LOCAL_SCHEMA_V24 = localSchemaIdentity(24)
export const LOCAL_SCHEMA_V25 = localSchemaIdentity(25)
export const LOCAL_SCHEMA_V26 = localSchemaIdentity(26)
export const LOCAL_SCHEMA_V27 = localSchemaIdentity(27)
export const LOCAL_SCHEMA_V28 = localSchemaIdentity(28)
export const LOCAL_SCHEMA_V29 = localSchemaIdentity(29)
export const LOCAL_SCHEMA_V30 = localSchemaIdentity(30)
export const LOCAL_SCHEMA_V31 = localSchemaIdentity(31)
export const LOCAL_SCHEMA_V32 = localSchemaIdentity(32)
export const LOCAL_SCHEMA_V33 = localSchemaIdentity(33)
export const LOCAL_SCHEMA_V34 = localSchemaIdentity(34)
export const LOCAL_SCHEMA_V36 = localSchemaIdentity(36)
export const LOCAL_SCHEMA_V37 = localSchemaIdentity(37)
export const LOCAL_SCHEMA_V38 = localSchemaIdentity(38)
export const LOCAL_SCHEMA_V39 = localSchemaIdentity(39)
export const LOCAL_SCHEMA_V40 = localSchemaIdentity(40)
export const LOCAL_SCHEMA_V41 = localSchemaIdentity(41)
export const LOCAL_SCHEMA_V42 = localSchemaIdentity(42)

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
