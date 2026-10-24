import * as PG from "@maple-dev/effect-orm/postgres"
import { RoleName } from "@maple/domain/http"
import { DeviceCredentialId, OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

/** The registered public key: EC P-256 only, so every proof is ES256. */
export const DeviceCredentialPublicJwk = Schema.Struct({
	kty: Schema.Literal("EC"),
	crv: Schema.Literal("P-256"),
	x: Schema.String,
	y: Schema.String,
})
export type DeviceCredentialPublicJwk = Schema.Schema.Type<typeof DeviceCredentialPublicJwk>

/** What an App Attest verification established, kept for audit and later assertion checks. */
export const DeviceCredentialAttestation = Schema.Struct({
	keyId: Schema.String,
	environment: Schema.Literals(["production", "development"]),
	counter: Schema.Number,
	/** Apple's receipt (base64), usable later to ask Apple for a fraud metric. */
	receipt: Schema.optionalKey(Schema.String),
	verifiedAt: Schema.Number,
})
export type DeviceCredentialAttestation = Schema.Schema.Type<typeof DeviceCredentialAttestation>

/**
 * A device-bound credential: a public key held in one installation's Secure Enclave, registered
 * by a signed-in session. Tokens minted for it are DPoP-bound (RFC 9449) to `jkt`, so a copy of
 * the widget's storage is useless without the private key that never leaves the device.
 */
export const DeviceCredentials = PG.table("device_credentials", {
	columns: {
		id: PG.brand(PG.text, DeviceCredentialId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		installationId: PG.column(PG.text, { name: "installation_id" }),
		publicJwk: PG.column(PG.jsonb(DeviceCredentialPublicJwk), { name: "public_jwk" }),
		/** RFC 7638 SHA-256 thumbprint of `publicJwk`, base64url. A key is never registered twice. */
		jkt: PG.text,
		roles: PG.jsonb(Schema.Array(RoleName)),
		scopes: PG.jsonb(Schema.Array(Schema.String)),
		attested: PG.column(PG.bool, { default: false }),
		attestation: PG.nullable(PG.jsonb(DeviceCredentialAttestation)),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		lastUsedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_used_at" }),
		/** Rolling: each registration refresh moves it out again, never past `hardExpiresAt`. */
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
		hardExpiresAt: PG.column(PG.timestamptzMillis, { name: "hard_expires_at" }),
		revokedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "revoked_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("device_credentials_jkt_unique", ["jkt"]),
		PG.index("device_credentials_org_installation_idx", ["orgId", "installationId"]),
		PG.index("device_credentials_user_idx", ["userId"]),
	],
	tenantColumn: "orgId",
})

export type DeviceCredentialRow = PG.SelectRowOf<typeof DeviceCredentials>
export type DeviceCredentialInsert = PG.InsertRowOf<typeof DeviceCredentials>

/**
 * Single-use values that must not be accepted twice while they are still fresh: DPoP proof
 * `jti`s (per key) and App Attest challenges. `key` is a SHA-256 over the kind and the value.
 * Rows are useless once `expiresAt` passes, and are pruned from then on.
 */
export const DeviceProofReplays = PG.table("device_proof_replays", {
	columns: {
		key: PG.text,
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
	},
	primaryKey: ["key"],
	indexes: [PG.index("device_proof_replays_expires_idx", ["expiresAt"])],
})

export type DeviceProofReplayRow = PG.SelectRowOf<typeof DeviceProofReplays>
