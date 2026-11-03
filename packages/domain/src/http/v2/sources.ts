import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { SourceNotFoundError, SourcePersistenceError, SourceValidationError } from "../sources"
import { IngestKeyEncryptionError } from "../ingest-keys"
import {
	PushSourcePlatform,
	SourceAttributeMode,
	SourceId,
	SourceKind,
	SourcePlatform,
	SourceSignal,
} from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { V2WarehouseReadErrors } from "./query-errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** `src_…` public ID ⇄ internal `SourceId` (raw UUID). */
export const SourcePublicId = PublicId(PublicIdPrefixes.source, SourceId)

const sourceExample = {
	id: "src_aXunrkWtzvXSkw9Z2smcft",
	object: "source",
	name: "Checkout staging",
	description: "Staging deploys of the checkout service",
	platform: "nodejs",
	kind: "token",
	is_default: false,
	key_prefix: "maple_src_Q7xZa",
	integration_id: null,
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
	health: { status: "healthy", last_data_at: "2026-07-15T09:14:00.000Z", problem: null, resources: null },
} as const

const allowedSignalsField = Schema.NullOr(Schema.Array(SourceSignal)).annotate({
	description:
		"Signals the source may send: `traces`, `logs`, `metrics`, `sessions` (session replays and automatic session events) and `events` (product events, including browser `track()` calls sent with session events). `null` allows every signal; other signals are rejected with 403, and session-event rows of a disallowed kind are dropped.",
	examples: [["traces", "logs"]],
})

const rateLimitField = Schema.NullOr(Schema.Int).annotate({
	description:
		"Maximum requests per second, between 1 and 100000, split evenly across the ingest servers at their minimum fleet size (so the total can run higher while the fleet is scaled out). `null` means no per-source limit. Requests over the limit are rejected with 429 and a `Retry-After` header.",
	examples: [200],
})

const V2SourceResourceAttribute = Schema.Struct({
	key: Schema.String.annotate({
		description:
			"Resource attribute key, e.g. `service.name`. `org_id` and keys starting with `maple_` (any case) are reserved.",
		examples: ["service.name"],
	}),
	value: Schema.String.annotate({
		description: "Non-empty string value to write, at most 1024 characters.",
		examples: ["checkout"],
	}),
	mode: SourceAttributeMode.annotate({
		description:
			"`set` always overwrites the attribute; `default` only fills it when the sender did not set it.",
		examples: ["set"],
	}),
}).annotate({
	identifier: "SourceResourceAttribute",
	title: "Source resource attribute",
	description: "A resource attribute the ingest gateway writes on every resource this source sends.",
})

const resourceAttributesField = Schema.Array(V2SourceResourceAttribute).annotate({
	description: "Resource attributes applied to all telemetry this source sends, at most 20.",
})

const expiresAtField = Schema.NullOr(Timestamp).annotate({
	description: "When the source token stops being accepted, or `null` if it never expires.",
})

const V2SourceHealth = Schema.Struct({
	status: Schema.Literals(["disconnected", "failing", "stale", "paused", "pending", "healthy"]).annotate({
		description:
			"`healthy`: data is arriving. `pending`: nothing has arrived yet. `stale`: data stopped arriving (a day for push sources; for pull sources, longer than the integration normally goes between collections). `failing`: the last attempt failed. `paused`: data is dropped on purpose. `disconnected`: the token expired or the integration was removed.",
		examples: ["healthy"],
	}),
	last_data_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When data last arrived from a push source, or when the integration last collected successfully. `null` if never.",
	}),
	problem: Schema.NullOr(Schema.String).annotate({
		description: "One line on why the source is not healthy, or `null` when it is.",
	}),
	resources: Schema.NullOr(
		Schema.Struct({
			total: Schema.Int.annotate({ description: "Resources the source stands for." }),
			unhealthy: Schema.Int.annotate({ description: "How many of them are not healthy." }),
		}),
	).annotate({
		description:
			"For a pull source that stands for several resources (a Cloudflare account's zones, a GitHub org's repositories): how many are not healthy, so `failing` can read as 1 of 3. `null` otherwise.",
	}),
}).annotate({
	identifier: "SourceHealth",
	title: "Source health",
	description: "Whether data from the source is arriving.",
})

export const V2Source = Schema.Struct({
	id: SourcePublicId,
	object: Schema.Literal("source").annotate({
		description: 'The object type, always `"source"`.',
		examples: ["source"],
	}),
	name: Schema.String.annotate({ description: "Human-readable label.", examples: ["Checkout staging"] }),
	description: Schema.NullOr(Schema.String).annotate({
		description: "Optional longer description, at most 500 characters.",
	}),
	platform: SourcePlatform.annotate({
		description:
			"What sends the data. Push platforms (`opentelemetry`, `nodejs`, `kubernetes`, …) send with the source's own token; pull platforms (`prometheus`, `cloudflare`, `gcp`, `railway`, `planetscale`, `github`) are integrations Maple collects from.",
		examples: ["nodejs"],
	}),
	kind: SourceKind.annotate({
		description:
			"`default` is the organization's built-in source for the default ingest keys, `token` sends with its own source token, `integration` is an integration Maple collects from and is removed by disconnecting it.",
		examples: ["token"],
	}),
	is_default: Schema.Boolean.annotate({
		description:
			"`true` for the organization's built-in source, which receives everything sent with the default public and private ingest keys. It cannot be deleted.",
	}),
	key_prefix: Schema.NullOr(Schema.String).annotate({
		description:
			"The non-secret leading portion of the source token, safe to display. The full token is returned only when the source is created or rolled. `null` for the default source and pull sources.",
		examples: ["maple_src_Q7xZa"],
	}),
	integration_id: Schema.NullOr(Schema.String).annotate({
		description:
			"For a pull source, the id of the integration record it stands for (a scrape target, a cloud connection or installation). `null` for push sources.",
	}),
	status: Schema.Literals(["active", "paused", "expired"]).annotate({
		description:
			"`active` sources are accepted. `paused` sources are accepted with a success response but their data is dropped, not stored or billed. `expired` tokens are rejected with 401.",
		examples: ["active"],
	}),
	allowed_signals: allowedSignalsField,
	rate_limit_rps: rateLimitField,
	resource_attributes: resourceAttributesField,
	expires_at: expiresAtField,
	paused_at: Schema.NullOr(Timestamp).annotate({
		description: "When the source was paused, or `null` if it is not paused.",
	}),
	paused_until: Schema.NullOr(Timestamp).annotate({
		description: "When a pause ends on its own. `null` while paused means paused until resumed.",
	}),
	last_used_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the gateway last accepted data from this source, updated at most once a minute (every 5 minutes for the default source). `null` if it never sent anything.",
	}),
	rolled_at: Schema.NullOr(Timestamp).annotate({
		description: "When the token was last rolled (or first created). `null` for sources without a token.",
	}),
	created_at: Timestamp.annotate({ description: "When the source was created." }),
	updated_at: Timestamp.annotate({ description: "When the source was last updated." }),
	health: V2SourceHealth,
}).annotate({
	identifier: "Source",
	title: "Source",
	description:
		"Something that sends data to Maple: an OpenTelemetry SDK or collector, a Kubernetes cluster, a Prometheus scrape, a cloud integration. Telemetry from a source is stamped with `maple_source_id`. A push source's token is shown only once, when it is created or rolled.",
	examples: [wireExample(sourceExample)],
})
export type V2Source = Schema.Schema.Type<typeof V2Source>

/** Returned only by create/roll: the one time the token is visible. */
export const V2SourceWithSecret = Schema.Struct({
	...V2Source.fields,
	secret: Schema.String.annotate({
		description:
			"The full source token, used as the ingest key. **Returned only once**, in the create and roll responses. Store it securely.",
		examples: ["maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"],
	}),
}).annotate({
	identifier: "SourceWithSecret",
	title: "Source (with token)",
	description: "A source including its one-time `secret`. Returned only by create and roll.",
	examples: [wireExample({ ...sourceExample, secret: "maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1" })],
})
export type V2SourceWithSecret = Schema.Schema.Type<typeof V2SourceWithSecret>

export const V2SourceCreateParams = Schema.Struct({
	name: Schema.String.annotate({ description: "Human-readable label. Required, at most 100 characters." }),
	platform: PushSourcePlatform.annotate({
		description:
			"What will send the data. Only push platforms can be created here; integrations create their own sources when connected.",
	}),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowed_signals: Schema.optionalKey(allowedSignalsField),
	rate_limit_rps: Schema.optionalKey(rateLimitField),
	resource_attributes: Schema.optionalKey(resourceAttributesField),
	expires_at: Schema.optionalKey(expiresAtField),
}).annotate({
	identifier: "SourceCreateParams",
	title: "Source create parameters",
	description: "Request body for creating a push source.",
	examples: [
		wireExample({
			name: "Checkout staging",
			platform: "nodejs",
			allowed_signals: ["traces", "logs"],
			resource_attributes: [{ key: "deployment.environment", value: "staging", mode: "set" }],
		}),
	],
})
export type V2SourceCreateParams = Schema.Schema.Type<typeof V2SourceCreateParams>

export const V2SourceUpdateParams = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowed_signals: Schema.optionalKey(allowedSignalsField),
	rate_limit_rps: Schema.optionalKey(rateLimitField),
	resource_attributes: Schema.optionalKey(resourceAttributesField),
	expires_at: Schema.optionalKey(expiresAtField),
}).annotate({
	identifier: "SourceUpdateParams",
	title: "Source update parameters",
	description:
		"Request body for updating a source. Omitted fields are unchanged; `null` clears a field. The default source only accepts `name` and `description`.",
	examples: [wireExample({ rate_limit_rps: 500 })],
})
export type V2SourceUpdateParams = Schema.Schema.Type<typeof V2SourceUpdateParams>

export const V2SourcePauseParams = Schema.Struct({
	until: Schema.optionalKey(
		Schema.NullOr(Timestamp).annotate({
			description: "When the pause ends on its own. Omit or `null` to pause until resumed.",
		}),
	),
}).annotate({
	identifier: "SourcePauseParams",
	title: "Source pause parameters",
	description: "Request body for pausing a source.",
	examples: [wireExample({ until: "2026-07-15T10:00:00.000Z" })],
})
export type V2SourcePauseParams = Schema.Schema.Type<typeof V2SourcePauseParams>

const spansField = Schema.Number.annotate({ description: "Spans stored from this source." })
const logsField = Schema.Number.annotate({ description: "Log records stored from this source." })
const metricsField = Schema.Number.annotate({ description: "Metric data points stored from this source." })
const bytesField = Schema.Number.annotate({
	description:
		"Estimated bytes stored from this source across all signals. An estimate of stored size, not billed usage.",
})

export const V2SourceUsage = Schema.Struct({
	object: Schema.Literal("source_usage"),
	window_start: Timestamp,
	window_end: Timestamp,
	buckets: Schema.Array(
		Schema.Struct({
			hour: Timestamp.annotate({ description: "Start of the hour." }),
			spans: Schema.Number.annotate({ description: "Spans stored from this source in the hour." }),
			logs: Schema.Number.annotate({ description: "Log records stored from this source in the hour." }),
			metrics: Schema.Number.annotate({
				description: "Metric data points stored from this source in the hour.",
			}),
			bytes: Schema.Number.annotate({
				description: "Estimated bytes stored from this source in the hour, across all signals.",
			}),
		}),
	).annotate({ description: "Hours with data, oldest first. Hours without data are omitted." }),
}).annotate({
	identifier: "SourceUsage",
	title: "Source usage",
	description:
		"Hourly span, log and metric data point counts and estimated stored bytes from a source, over 24 whole hours ending with the current one.",
	examples: [
		wireExample({
			object: "source_usage",
			window_start: "2026-07-14T10:00:00.000Z",
			window_end: "2026-07-15T09:42:00.000Z",
			buckets: [
				{
					hour: "2026-07-15T09:00:00.000Z",
					spans: 51234,
					logs: 12873,
					metrics: 8400,
					bytes: 23891200,
				},
			],
		}),
	],
})
export type V2SourceUsage = Schema.Schema.Type<typeof V2SourceUsage>

export const V2SourceUsageSummary = Schema.Struct({
	object: Schema.Literal("source_usage_summary"),
	window_start: Timestamp,
	window_end: Timestamp,
	data: Schema.Array(
		Schema.Struct({
			source_id: SourcePublicId,
			spans: spansField,
			logs: logsField,
			metrics: metricsField,
			bytes: bytesField,
		}),
	).annotate({
		description:
			"One entry per source with data in the window, largest first. Sources without data are omitted.",
	}),
}).annotate({
	identifier: "SourceUsageSummary",
	title: "Source usage summary",
	description:
		"Span, log and metric data point counts and estimated stored bytes per source, over 24 whole hours ending with the current one.",
	examples: [
		wireExample({
			object: "source_usage_summary",
			window_start: "2026-07-14T10:00:00.000Z",
			window_end: "2026-07-15T09:42:00.000Z",
			data: [
				{
					source_id: "src_aXunrkWtzvXSkw9Z2smcft",
					spans: 1203400,
					logs: 302877,
					metrics: 201600,
					bytes: 551203840,
				},
			],
		}),
	],
})
export type V2SourceUsageSummary = Schema.Schema.Type<typeof V2SourceUsageSummary>

export const V2SourceDeleteResponse = Schema.Struct({
	id: SourcePublicId,
	object: Schema.Literal("source"),
	deleted: Schema.Literal(true),
	cleanup_script: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"Google Cloud sources only: a shell script that removes what the connector's setup created in the project.",
		}),
	),
}).annotate({
	identifier: "SourceDeleteResponse",
	title: "Source delete response",
	description:
		"Confirmation that a source was deleted. Senders using its token are rejected within a minute; an integration source's integration is disconnected.",
	examples: [wireExample({ id: "src_aXunrkWtzvXSkw9Z2smcft", object: "source", deleted: true })],
})
export type V2SourceDeleteResponse = Schema.Schema.Type<typeof V2SourceDeleteResponse>

const SourceList = ListOf(V2Source).annotate({
	identifier: "SourceList",
	title: "Source list",
	description: "A cursor-paginated page of sources.",
})

const [sourceNotFound, sourceInvalid] = publicErrors(SourceNotFoundError, SourceValidationError)
const sourceErrors = publicErrors(SourcePersistenceError, IngestKeyEncryptionError)

export class V2SourcesApiGroup extends HttpApiGroup.make("sources")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: SourceList,
			error: [V2InsufficientPermissions.schema, V2ParameterInvalid.schema, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listSources",
				summary: "List sources",
				description:
					"Returns your organization's sources (without tokens): the default source first, then the most recently created. Requires an org-admin role and the `sources:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2SourceCreateParams,
			success: V2SourceWithSecret,
			error: [V2InsufficientPermissions.schema, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createSource",
				summary: "Create a source",
				description:
					"Creates a push source and returns it **with its one-time `secret`**, the token its senders use as their ingest key. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	// The router matches static `/usage` before `/:id`; sources.http.test.ts pins it.
	.add(
		HttpApiEndpoint.get("usageSummary", "/usage", {
			success: V2SourceUsageSummary,
			error: [V2InsufficientPermissions.schema, ...sourceErrors, ...V2WarehouseReadErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSourcesUsage",
				summary: "Retrieve usage for all sources",
				description:
					"Returns span, log and metric data point counts and estimated stored bytes per source, over 24 whole hours ending with the current one. Sources without data in the window are omitted. Requires an org-admin role and the `sources:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: SourcePublicId },
			success: V2Source,
			error: [V2InsufficientPermissions.schema, sourceNotFound, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSource",
				summary: "Retrieve a source",
				description:
					"Returns a source by its `src_…` ID (without the token). Requires an org-admin role and the `sources:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: SourcePublicId },
			payload: V2SourceUpdateParams,
			success: V2Source,
			error: [V2InsufficientPermissions.schema, sourceNotFound, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateSource",
				summary: "Update a source",
				description:
					"Updates a source's settings; omitted fields are unchanged. The ingest gateway picks up changes within a minute. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("roll", "/:id/roll", {
			params: { id: SourcePublicId },
			success: V2SourceWithSecret,
			error: [V2InsufficientPermissions.schema, sourceNotFound, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rollSource",
				summary: "Roll a source token",
				description:
					"Replaces a push source's token, keeping its ID and settings, and returns the new one-time `secret`. The previous token stops working within a minute. The default source rolls through the ingest keys endpoints. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("pause", "/:id/pause", {
			params: { id: SourcePublicId },
			payload: V2SourcePauseParams,
			success: V2Source,
			error: [V2InsufficientPermissions.schema, sourceNotFound, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "pauseSource",
				summary: "Pause a source",
				description:
					"Pauses ingestion for a source until `until`, or until resumed. Senders keep getting success responses, so nothing retries or backs up, but their data is dropped and not billed. Takes effect within a minute. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("resume", "/:id/resume", {
			params: { id: SourcePublicId },
			success: V2Source,
			error: [V2InsufficientPermissions.schema, sourceNotFound, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resumeSource",
				summary: "Resume a source",
				description:
					"Ends a pause so data from the source is stored again, within a minute. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("usage", "/:id/usage", {
			params: { id: SourcePublicId },
			success: V2SourceUsage,
			error: [
				V2InsufficientPermissions.schema,
				sourceNotFound,
				...sourceErrors,
				...V2WarehouseReadErrors,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSourceUsage",
				summary: "Retrieve source usage",
				description:
					"Returns hourly span, log and metric data point counts and estimated stored bytes from the source, over 24 whole hours ending with the current one. Requires an org-admin role and the `sources:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: SourcePublicId },
			success: V2SourceDeleteResponse,
			error: [V2InsufficientPermissions.schema, sourceNotFound, sourceInvalid, ...sourceErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteSource",
				summary: "Delete a source",
				description:
					"Permanently deletes a source. Senders using a push source's token are rejected within a minute. Deleting an integration source disconnects its integration: Maple revokes the credential it holds and stops collecting. Data already stored is kept until retention ends. The default source cannot be deleted. Requires an org-admin role and the `sources:write` scope.",
			}),
		),
	)
	.prefix("/v2/sources")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Sources",
			description:
				"Everything that sends data to your organization: OpenTelemetry SDKs and collectors, Kubernetes clusters, Prometheus scrapes and cloud integrations. Push sources get their own token with allowed signals, a rate limit and resource attributes. All operations are admin-only.",
		}),
	) {}
