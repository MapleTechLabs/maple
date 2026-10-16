import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	CustomIngestKeyNotFoundError,
	CustomIngestKeyValidationError,
	IngestKeyEncryptionError,
	IngestKeyPersistenceError,
} from "../ingest-keys"
import { CustomIngestKeyId, IngestKeyAttributeMode, IngestKeySignal } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { V2WarehouseReadErrors } from "./query-errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

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

const ingestKeyErrors = publicErrors(IngestKeyPersistenceError, IngestKeyEncryptionError)

/** `ingk_…` public ID ⇄ internal `CustomIngestKeyId` (raw UUID). */
export const CustomIngestKeyPublicId = PublicId(PublicIdPrefixes.ingestKey, CustomIngestKeyId)

const customIngestKeyExample = {
	id: "ingk_aXunrkWtzvXSkw9Z2smcft",
	object: "custom_ingest_key",
	name: "Checkout staging",
	description: "Staging deploys of the checkout service",
	key_prefix: "maple_ik_Q7xZa",
	status: "active",
	allowed_signals: ["traces", "logs"],
	rate_limit_rps: 200,
	resource_attributes: [
		{ key: "service.name", value: "checkout", mode: "default" },
		{ key: "deployment.environment", value: "staging", mode: "set" },
	],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: "2026-07-15T09:14:00.000Z",
	rolled_at: "2026-07-01T12:00:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

const allowedSignalsField = Schema.NullOr(Schema.Array(IngestKeySignal)).annotate({
	description:
		"Signals the key may send: `traces`, `logs`, `metrics`, `sessions` (session replays and automatic session events) and `events` (product events, including browser `track()` calls sent with session events). `null` allows every signal; other signals are rejected with 403, and session-event rows of a disallowed kind are dropped.",
	examples: [["traces", "logs"]],
})

const rateLimitField = Schema.NullOr(Schema.Int).annotate({
	description:
		"Maximum requests per second, between 1 and 100000, split evenly across the ingest servers at their minimum fleet size (so the total can run higher while the fleet is scaled out). `null` means no per-key limit. Requests over the limit are rejected with 429 and a `Retry-After` header.",
	examples: [200],
})

const V2IngestKeyResourceAttribute = Schema.Struct({
	key: Schema.String.annotate({
		description:
			"Resource attribute key, e.g. `service.name`. `org_id` and keys starting with `maple_` (any case) are reserved.",
		examples: ["service.name"],
	}),
	value: Schema.String.annotate({
		description: "Non-empty string value to write, at most 1024 characters.",
		examples: ["checkout"],
	}),
	mode: IngestKeyAttributeMode.annotate({
		description:
			"`set` always overwrites the attribute; `default` only fills it when the sender did not set it.",
		examples: ["set"],
	}),
}).annotate({
	identifier: "IngestKeyResourceAttribute",
	title: "Ingest key resource attribute",
	description: "A resource attribute the ingest gateway writes on every resource sent with this key.",
})

const resourceAttributesField = Schema.Array(V2IngestKeyResourceAttribute).annotate({
	description: "Resource attributes applied to all telemetry sent with this key, at most 20.",
})

const expiresAtField = Schema.NullOr(Timestamp).annotate({
	description: "When the key stops being accepted, or `null` if it never expires.",
})

export const V2CustomIngestKey = Schema.Struct({
	id: CustomIngestKeyPublicId,
	object: Schema.Literal("custom_ingest_key").annotate({
		description: 'The object type, always `"custom_ingest_key"`.',
		examples: ["custom_ingest_key"],
	}),
	name: Schema.String.annotate({ description: "Human-readable label.", examples: ["Checkout staging"] }),
	description: Schema.NullOr(Schema.String).annotate({
		description: "Optional longer description, at most 500 characters.",
	}),
	key_prefix: Schema.String.annotate({
		description:
			"The non-secret leading portion of the key, safe to display. The full key is returned only when it is created or rolled.",
		examples: ["maple_ik_Q7xZa"],
	}),
	status: Schema.Literals(["active", "paused", "expired"]).annotate({
		description:
			"`active` keys are accepted. `paused` keys are accepted with a success response but their data is dropped, not stored or billed. `expired` keys are rejected with 401.",
		examples: ["active"],
	}),
	allowed_signals: allowedSignalsField,
	rate_limit_rps: rateLimitField,
	resource_attributes: resourceAttributesField,
	expires_at: expiresAtField,
	paused_at: Schema.NullOr(Timestamp).annotate({
		description: "When the key was paused, or `null` if it is not paused.",
	}),
	paused_until: Schema.NullOr(Timestamp).annotate({
		description: "When a pause ends on its own. `null` while paused means paused until resumed.",
	}),
	last_used_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the gateway last accepted data sent with this key, updated at most once a minute. `null` if never used.",
	}),
	rolled_at: Timestamp.annotate({ description: "When the secret was last rolled (or first created)." }),
	created_at: Timestamp.annotate({ description: "When the key was created." }),
	updated_at: Timestamp.annotate({ description: "When the key was last updated." }),
}).annotate({
	identifier: "CustomIngestKey",
	title: "Custom Ingest Key",
	description:
		"An additional named ingest key with its own settings: allowed signals, a rate limit and resource attribute overrides. Telemetry sent with it is stamped with `maple_ingest_key_id`. The secret is shown only once, when the key is created or rolled.",
	examples: [wireExample(customIngestKeyExample)],
})
export type V2CustomIngestKey = Schema.Schema.Type<typeof V2CustomIngestKey>

/** Returned only by create/roll: the one time the secret is visible. */
export const V2CustomIngestKeyWithSecret = Schema.Struct({
	...V2CustomIngestKey.fields,
	secret: Schema.String.annotate({
		description:
			"The full ingest key. **Returned only once**, in the create and roll responses. Store it securely.",
		examples: ["maple_ik_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"],
	}),
}).annotate({
	identifier: "CustomIngestKeyWithSecret",
	title: "Custom Ingest Key (with secret)",
	description: "A custom ingest key including its one-time `secret`. Returned only by create and roll.",
	examples: [
		wireExample({ ...customIngestKeyExample, secret: "maple_ik_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1" }),
	],
})
export type V2CustomIngestKeyWithSecret = Schema.Schema.Type<typeof V2CustomIngestKeyWithSecret>

export const V2CustomIngestKeyCreateParams = Schema.Struct({
	name: Schema.String.annotate({ description: "Human-readable label. Required, at most 100 characters." }),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowed_signals: Schema.optionalKey(allowedSignalsField),
	rate_limit_rps: Schema.optionalKey(rateLimitField),
	resource_attributes: Schema.optionalKey(resourceAttributesField),
	expires_at: Schema.optionalKey(expiresAtField),
}).annotate({
	identifier: "CustomIngestKeyCreateParams",
	title: "Custom ingest key create parameters",
	description: "Request body for creating a custom ingest key.",
	examples: [
		wireExample({
			name: "Checkout staging",
			allowed_signals: ["traces", "logs"],
			rate_limit_rps: 200,
			resource_attributes: [{ key: "deployment.environment", value: "staging", mode: "set" }],
		}),
	],
})
export type V2CustomIngestKeyCreateParams = Schema.Schema.Type<typeof V2CustomIngestKeyCreateParams>

export const V2CustomIngestKeyUpdateParams = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowed_signals: Schema.optionalKey(allowedSignalsField),
	rate_limit_rps: Schema.optionalKey(rateLimitField),
	resource_attributes: Schema.optionalKey(resourceAttributesField),
	expires_at: Schema.optionalKey(expiresAtField),
}).annotate({
	identifier: "CustomIngestKeyUpdateParams",
	title: "Custom ingest key update parameters",
	description:
		"Request body for updating a custom ingest key. Omitted fields are unchanged; `null` clears a field.",
	examples: [wireExample({ rate_limit_rps: 500 })],
})
export type V2CustomIngestKeyUpdateParams = Schema.Schema.Type<typeof V2CustomIngestKeyUpdateParams>

export const V2CustomIngestKeyPauseParams = Schema.Struct({
	until: Schema.optionalKey(
		Schema.NullOr(Timestamp).annotate({
			description: "When the pause ends on its own. Omit or `null` to pause until resumed.",
		}),
	),
}).annotate({
	identifier: "CustomIngestKeyPauseParams",
	title: "Custom ingest key pause parameters",
	description: "Request body for pausing a custom ingest key.",
	examples: [wireExample({ until: "2026-07-15T10:00:00.000Z" })],
})
export type V2CustomIngestKeyPauseParams = Schema.Schema.Type<typeof V2CustomIngestKeyPauseParams>

export const V2CustomIngestKeyUsage = Schema.Struct({
	object: Schema.Literal("custom_ingest_key_usage"),
	window_start: Timestamp,
	window_end: Timestamp,
	buckets: Schema.Array(
		Schema.Struct({
			hour: Timestamp.annotate({ description: "Start of the hour." }),
			spans: Schema.Number.annotate({ description: "Spans stored with this key in the hour." }),
			logs: Schema.Number.annotate({ description: "Log records stored with this key in the hour." }),
		}),
	).annotate({ description: "Hours with data, oldest first. Hours without data are omitted." }),
}).annotate({
	identifier: "CustomIngestKeyUsage",
	title: "Custom ingest key usage",
	description: "Hourly span and log counts stored with a custom ingest key over the last 24 hours.",
	examples: [
		wireExample({
			object: "custom_ingest_key_usage",
			window_start: "2026-07-14T10:00:00.000Z",
			window_end: "2026-07-15T10:00:00.000Z",
			buckets: [{ hour: "2026-07-15T09:00:00.000Z", spans: 51234, logs: 12873 }],
		}),
	],
})
export type V2CustomIngestKeyUsage = Schema.Schema.Type<typeof V2CustomIngestKeyUsage>

export const V2CustomIngestKeyDeleteResponse = Schema.Struct({
	id: CustomIngestKeyPublicId,
	object: Schema.Literal("custom_ingest_key"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "CustomIngestKeyDeleteResponse",
	title: "Custom ingest key delete response",
	description:
		"Confirmation that a custom ingest key was deleted. Senders using it are rejected within a minute.",
	examples: [
		wireExample({ id: "ingk_aXunrkWtzvXSkw9Z2smcft", object: "custom_ingest_key", deleted: true }),
	],
})
export type V2CustomIngestKeyDeleteResponse = Schema.Schema.Type<typeof V2CustomIngestKeyDeleteResponse>

const CustomIngestKeyList = ListOf(V2CustomIngestKey).annotate({
	identifier: "CustomIngestKeyList",
	title: "Custom ingest key list",
	description: "A cursor-paginated page of custom ingest keys.",
})

const [customKeyNotFound, customKeyInvalid] = publicErrors(
	CustomIngestKeyNotFoundError,
	CustomIngestKeyValidationError,
)

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
	.add(
		HttpApiEndpoint.get("listCustom", "/custom", {
			query: ListQuery,
			success: CustomIngestKeyList,
			error: [V2InsufficientPermissions.schema, V2ParameterInvalid.schema, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listCustomIngestKeys",
				summary: "List custom ingest keys",
				description:
					"Returns your organization's custom ingest keys (without secrets), most recently created first. Requires an org-admin role and the `ingest_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createCustom", "/custom", {
			payload: V2CustomIngestKeyCreateParams,
			success: V2CustomIngestKeyWithSecret,
			error: [V2InsufficientPermissions.schema, customKeyInvalid, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createCustomIngestKey",
				summary: "Create a custom ingest key",
				description:
					"Creates a named ingest key and returns it **with its one-time `secret`**. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveCustom", "/custom/:id", {
			params: { id: CustomIngestKeyPublicId },
			success: V2CustomIngestKey,
			error: [V2InsufficientPermissions.schema, customKeyNotFound, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getCustomIngestKey",
				summary: "Retrieve a custom ingest key",
				description:
					"Returns a custom ingest key by its `ingk_…` ID (without the secret). Requires an org-admin role and the `ingest_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateCustom", "/custom/:id", {
			params: { id: CustomIngestKeyPublicId },
			payload: V2CustomIngestKeyUpdateParams,
			success: V2CustomIngestKey,
			error: [
				V2InsufficientPermissions.schema,
				customKeyNotFound,
				customKeyInvalid,
				...ingestKeyErrors,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateCustomIngestKey",
				summary: "Update a custom ingest key",
				description:
					"Updates a key's settings; omitted fields are unchanged. The ingest gateway picks up changes within a minute. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rollCustom", "/custom/:id/roll", {
			params: { id: CustomIngestKeyPublicId },
			success: V2CustomIngestKeyWithSecret,
			error: [V2InsufficientPermissions.schema, customKeyNotFound, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rollCustomIngestKey",
				summary: "Roll a custom ingest key",
				description:
					"Replaces the key's secret, keeping its ID and settings, and returns the new one-time `secret`. The previous secret stops working within a minute. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("pauseCustom", "/custom/:id/pause", {
			params: { id: CustomIngestKeyPublicId },
			payload: V2CustomIngestKeyPauseParams,
			success: V2CustomIngestKey,
			error: [
				V2InsufficientPermissions.schema,
				customKeyNotFound,
				customKeyInvalid,
				...ingestKeyErrors,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "pauseCustomIngestKey",
				summary: "Pause a custom ingest key",
				description:
					"Pauses ingestion for a key until `until`, or until resumed. Senders keep getting success responses, so nothing retries or backs up, but their data is dropped and not billed. Takes effect within a minute. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("resumeCustom", "/custom/:id/resume", {
			params: { id: CustomIngestKeyPublicId },
			success: V2CustomIngestKey,
			error: [V2InsufficientPermissions.schema, customKeyNotFound, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resumeCustomIngestKey",
				summary: "Resume a custom ingest key",
				description:
					"Ends a pause so data sent with the key is stored again, within a minute. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("usageCustom", "/custom/:id/usage", {
			params: { id: CustomIngestKeyPublicId },
			success: V2CustomIngestKeyUsage,
			error: [
				V2InsufficientPermissions.schema,
				customKeyNotFound,
				...ingestKeyErrors,
				...V2WarehouseReadErrors,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getCustomIngestKeyUsage",
				summary: "Retrieve custom ingest key usage",
				description:
					"Returns hourly span and log counts stored with the key over the last 24 hours. Requires an org-admin role and the `ingest_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteCustom", "/custom/:id", {
			params: { id: CustomIngestKeyPublicId },
			success: V2CustomIngestKeyDeleteResponse,
			error: [V2InsufficientPermissions.schema, customKeyNotFound, ...ingestKeyErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteCustomIngestKey",
				summary: "Delete a custom ingest key",
				description:
					"Permanently deletes a custom ingest key. Senders using it are rejected within a minute. Requires an org-admin role and the `ingest_keys:write` scope.",
			}),
		),
	)
	.prefix("/v2/ingest_keys")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Ingest Keys",
			description:
				"Telemetry ingest credentials for your organization: a default public key for client-side senders, a default private key for server-side senders, and any number of custom keys with their own allowed signals, rate limit and resource attributes. All operations are admin-only.",
		}),
	) {}
