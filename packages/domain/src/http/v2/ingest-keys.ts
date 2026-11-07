import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { IngestKeyEncryptionError, IngestKeyPersistenceError } from "../ingest-keys"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"

const ingestKeysExample = {
	object: "ingest_keys",
	public_key: "maple_pk_9f2cB1x8Kt7pQ2wR5vN0sL3d",
	private_key: "maple_sk_J6hM4gY9dW1eF8aZ3cV7bN2m",
	public_rotated_at: "2026-07-01T12:00:00.000Z",
	private_rotated_at: "2026-07-01T12:00:00.000Z",
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts. Ingest keys are a per-organization singleton, so there is
// no `id` and no list envelope.
export const V2IngestKeys = Schema.Struct({
	object: Schema.Literal("ingest_keys").annotate({
		description: 'The object type — always `"ingest_keys"`.',
		examples: ["ingest_keys"],
	}),
	public_key: Schema.String.annotate({
		description:
			"The public ingest key. Safe to embed in browser and mobile telemetry senders; it can only write telemetry, never read data.",
		examples: ["maple_pk_9f2cB1x8Kt7pQ2wR5vN0sL3d"],
	}),
	private_key: Schema.String.annotate({
		description:
			"The private ingest key for server-side telemetry senders. Keep it secret — treat a leak as cause to roll.",
		examples: ["maple_sk_J6hM4gY9dW1eF8aZ3cV7bN2m"],
	}),
	public_rotated_at: Timestamp.annotate({
		description: "When the public key was last rolled (or first created).",
	}),
	private_rotated_at: Timestamp.annotate({
		description: "When the private key was last rolled (or first created).",
	}),
}).annotate({
	identifier: "IngestKeys",
	title: "Ingest Keys",
	description:
		"Your organization's telemetry ingest credentials — a public key for client-side senders and a private key for server-side senders. A per-organization singleton: rolling a key immediately invalidates its predecessor.",
	examples: [wireExample(ingestKeysExample)],
})
export type V2IngestKeys = Schema.Schema.Type<typeof V2IngestKeys>

export const V2PublicIngestKey = Schema.Struct({
	object: Schema.Literal("public_ingest_key").annotate({
		description: 'The object type, always `"public_ingest_key"`.',
		examples: ["public_ingest_key"],
	}),
	public_key: V2IngestKeys.fields.public_key,
	public_rotated_at: V2IngestKeys.fields.public_rotated_at,
}).annotate({
	identifier: "PublicIngestKey",
	title: "Public Ingest Key",
	description:
		"Your organization's public ingest key alone. Every member may read it: it is made to ship in browser and mobile code, and it can only send telemetry.",
	examples: [
		wireExample({
			object: "public_ingest_key",
			public_key: ingestKeysExample.public_key,
			public_rotated_at: ingestKeysExample.public_rotated_at,
		}),
	],
})
export type V2PublicIngestKey = Schema.Schema.Type<typeof V2PublicIngestKey>

const ingestKeyErrors = publicErrors(IngestKeyPersistenceError, IngestKeyEncryptionError)

export class V2IngestKeysApiGroup extends HttpApiGroup.make("ingestKeys")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2IngestKeys,
			error: [V2InsufficientPermissions.schema, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getIngestKeys",
				summary: "Retrieve ingest keys",
				description:
					"Returns your organization's ingest keys, creating them on first access. Requires an org-admin role and the `ingest_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrievePublic", "/public", {
			success: V2PublicIngestKey,
			error: [V2InsufficientPermissions.schema, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getPublicIngestKey",
				summary: "Retrieve the public ingest key",
				description:
					"Returns your organization's public ingest key, creating the keys on first access. Any member may call it. Requires the `ingest_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rollPublic", "/public/roll", {
			success: V2IngestKeys,
			error: [V2InsufficientPermissions.schema, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rollPublicIngestKey",
				summary: "Roll the public ingest key",
				description:
					"Replaces the public ingest key with a new one, **immediately invalidating the previous key** — telemetry senders still using it will be rejected. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rollPrivate", "/private/roll", {
			success: V2IngestKeys,
			error: [V2InsufficientPermissions.schema, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rollPrivateIngestKey",
				summary: "Roll the private ingest key",
				description:
					"Replaces the private ingest key with a new one, **immediately invalidating the previous key** — telemetry senders still using it will be rejected. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.prefix("/v2/ingest_keys")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Ingest Keys",
			description:
				"Telemetry ingest credentials for your organization: a public key for client-side senders and a private key for server-side senders. Retrieve them or roll either key. Any member may read the public key; reading both keys takes an engineer or admin, and rolling one takes an admin.",
		}),
	) {}
