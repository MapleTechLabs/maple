// Supabase Management API calls made with an OAuth access token. Field names follow the OpenAPI specs
// (https://api.supabase.com/api/v1-json, v2-json for log drains); extra fields are ignored so
// additions never break decode.
import { SupabaseProjectRef } from "@maple/primitives"
import { Duration, Effect, Option, Redacted, Schema, Array as Arr, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../vendor-http"

const REQUEST_TIMEOUT = Duration.seconds(20)

export class SupabaseApiError extends Schema.TaggedError<SupabaseApiError>()(
	"@maple/supabase/SupabaseApiError",
	{
		message: Schema.String,
		/** `unauthorized` (401) drives refresh-and-retry; `rate_limited` (429) is retryable later. */
		kind: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "upstream"]),
		status: Schema.optionalKey(Schema.Finite),
		retryAfterSeconds: Schema.optionalKey(Schema.Finite),
	},
) {}

export const DRAINS_PLAN_MESSAGE = "Log drains need a Supabase Pro plan or higher."

/** Supabase answered 402: the organization's plan does not include the feature (log drains need Pro). */
export class SupabasePlanRequiredError extends Schema.TaggedError<SupabasePlanRequiredError>()(
	"@maple/supabase/SupabasePlanRequiredError",
	{ message: Schema.String },
) {}

export const isSupabaseTokenRejected = (error: unknown): error is SupabaseApiError =>
	Schema.is(SupabaseApiError)(error) && error.kind === "unauthorized"

/** `GET /v1/organizations` item (`OrganizationResponseV1`); live responses carry `id` and `slug`. */
const OrganizationSchema = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String })
export type SupabaseOrganization = typeof OrganizationSchema.Type

/** `GET /v1/projects` item (`V1ProjectWithDatabaseResponse`), only the fields Maple keeps. */
const ProjectSchema = Schema.Struct({
	ref: SupabaseProjectRef,
	organization_id: Schema.String,
	organization_slug: Schema.optionalKey(Schema.String),
	name: Schema.String,
	region: Schema.String,
	status: Schema.String,
	created_at: Schema.optionalKey(Schema.String),
})
export type SupabaseProject = typeof ProjectSchema.Type

const decodeJsonArray = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))
const decodeOrganization = Schema.decodeUnknownOption(OrganizationSchema)
const decodeProject = Schema.decodeUnknownOption(ProjectSchema)

/** Error bodies come as `{ error: { message, description } }` or `{ message }`; both are read. */
const ErrorBodySchema = Schema.Union([
	Schema.Struct({
		error: Schema.Struct({
			message: Schema.optionalKey(Schema.String),
			description: Schema.optionalKey(Schema.String),
		}),
	}),
	Schema.Struct({ message: Schema.String }),
])
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBodySchema))

/** Supabase's own message, read from the whole body before the kit cuts it. */
const supabaseDetail = (text: string) =>
	Option.match(decodeErrorBody(text), {
		onNone: () => undefined,
		onSome: (body) => ("error" in body ? (body.error.description ?? body.error.message) : body.message),
	})

/** A failed call as a {@link SupabaseApiError}, in the words each status has always had. */
const toSupabaseError = (error: VendorHttp.VendorHttpError): SupabaseApiError => {
	const what = error.operation ?? "calling the Management API"
	const status = error.status === undefined ? undefined : { status: error.status }
	const detail = error.detail === undefined ? "" : `: ${Str.slice(0, 300)(error.detail)}`
	switch (error.kind) {
		case "unauthorized":
			return new SupabaseApiError({
				message: `Supabase rejected the access token while ${what}`,
				kind: "unauthorized",
				...status,
			})
		case "forbidden":
			return new SupabaseApiError({
				message: `Supabase denied ${what}${detail || ": the OAuth app may be missing a scope"}`,
				kind: "forbidden",
				...status,
			})
		case "rate_limited":
			return new SupabaseApiError({
				message: `Supabase rate limited ${what}`,
				kind: "rate_limited",
				...status,
				...(error.retryAfterSeconds === undefined
					? undefined
					: { retryAfterSeconds: error.retryAfterSeconds }),
			})
		case "timeout":
			return new SupabaseApiError({ message: `Supabase timed out while ${what}`, kind: "upstream" })
		case "not_found":
		case "upstream":
		case "invalid_response":
			return new SupabaseApiError({
				message:
					error.status === undefined
						? `Supabase request failed while ${what}`
						: `Supabase answered ${error.status} while ${what}${detail}`,
				kind: "upstream",
				...status,
			})
	}
}

/** A Management API client; `auth` is the OAuth bearer, or none for the OAuth endpoints. */
export const supabaseClient = (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	auth: VendorHttp.VendorAuth,
) =>
	VendorHttp.make({
		httpClient,
		peerService: "supabase",
		baseUrl,
		auth,
		headers: { accept: "application/json" },
		toError: toSupabaseError,
		detail: supabaseDetail,
		timeout: REQUEST_TIMEOUT,
		rateLimitResetHeader: "x-ratelimit-reset",
	})

const getArray = (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	path: string,
	accessToken: string,
	what: string,
) =>
	supabaseClient(httpClient, baseUrl, VendorHttp.bearer(accessToken))
		.text({ path, operation: what })
		.pipe(
			Effect.flatMap((text) =>
				decodeJsonArray(text).pipe(
					Effect.mapError(
						() =>
							new SupabaseApiError({
								message: `Supabase returned an unexpected body while ${what}`,
								kind: "upstream",
							}),
					),
				),
			),
		)

/** Organizations the token reaches. A Management API OAuth grant covers exactly one. */
export const listOrganizations = Effect.fn("SupabaseApi.listOrganizations")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
) {
	const items = yield* getArray(
		httpClient,
		baseUrl,
		"/v1/organizations",
		accessToken,
		"listing organizations",
	)
	const organizations = Arr.flatMap(items, (item) => Option.toArray(decodeOrganization(item)))
	// A dropped org would make a partial listing look complete, so any undecodable item fails.
	if (organizations.length !== items.length) {
		return yield* new SupabaseApiError({
			message: `Supabase returned ${items.length - organizations.length} organization(s) Maple could not read while listing organizations`,
			kind: "upstream",
		})
	}
	return organizations
})

/**
 * Every project the token reaches. Undecodable items are skipped and counted, so callers can
 * tell an incomplete listing from a complete one.
 */
export const listProjects = Effect.fn("SupabaseApi.listProjects")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
) {
	const items = yield* getArray(httpClient, baseUrl, "/v1/projects", accessToken, "listing projects")
	const projects = Arr.flatMap(items, (item) => Option.toArray(decodeProject(item)))
	yield* Effect.annotateCurrentSpan({
		"maple.supabase.projects_listed": items.length,
		"maple.supabase.projects_skipped": items.length - projects.length,
	})
	return { projects, skipped: items.length - projects.length }
})

/** `POST /v1/oauth/revoke`: revokes the app's authorization and every token it issued. */
export const revokeGrant = Effect.fn("SupabaseApi.revokeGrant")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	params: {
		readonly clientId: string
		readonly clientSecret: Redacted.Redacted
		readonly refreshToken: string
	},
) {
	// Revoking twice is harmless, so a passing failure is retried like a read.
	yield* supabaseClient(httpClient, baseUrl, VendorHttp.noAuth).text({
		method: "POST",
		path: "/v1/oauth/revoke",
		body: {
			client_id: params.clientId,
			client_secret: Redacted.value(params.clientSecret),
			refresh_token: params.refreshToken,
		},
		operation: "revoking the authorization",
		retry: true,
	})
})

/** A `log_drain` resource (`ListLogDrainsResponse_Output.data[]`); the config stays opaque here. */
const LogDrainSchema = Schema.Struct({
	id: Schema.String,
	attributes: Schema.Struct({
		name: Schema.String,
		description: Schema.optionalKey(Schema.String),
		backend_type: Schema.String,
		config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	}),
})
export type SupabaseLogDrain = typeof LogDrainSchema.Type

const decodeCreatedDrain = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ data: LogDrainSchema })),
)
const decodeDrainList = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) })),
)
const decodeDrain = Schema.decodeUnknownOption(LogDrainSchema)

const configString = (config: Readonly<Record<string, unknown>> | undefined, key: string) => {
	const value = config?.[key]
	return typeof value === "string" && value.length > 0 ? value : null
}

/** The host of a URL-ish config value; never its path, query or userinfo (a Sentry DSN key). */
const hostOf = (value: string | null) => {
	if (value === null) return null
	return URL.canParse(value) ? new URL(value).host || null : null
}

/**
 * Where a drain sends, without anything secret: a host for URL backends, the bucket for S3, the
 * region for Datadog and Last9. Every config field Supabase documents is read by name; nothing else.
 */
export const logDrainDestination = (drain: SupabaseLogDrain): string | null => {
	const config = drain.attributes.config
	switch (drain.attributes.backend_type) {
		case "otlp":
			return hostOf(configString(config, "endpoint"))
		case "webhook":
		case "loki":
			return hostOf(configString(config, "url"))
		case "sentry":
			return hostOf(configString(config, "dsn"))
		case "axiom":
			return configString(config, "domain")
		case "syslog":
			return configString(config, "host")
		case "s3": {
			const bucket = configString(config, "s3_bucket")
			return bucket === null ? null : `s3://${bucket}`
		}
		case "datadog":
		case "last9":
			return configString(config, "region")
		default:
			return null
	}
}

/** What Maple asks Supabase to send: OTLP logs to the ingest gateway, as one token source. */
export interface OtlpLogDrainSpec {
	readonly name: string
	readonly description: string
	/** Full OTLP/HTTP logs URL, e.g. `https://ingest.maple.dev/v1/logs`. */
	readonly endpoint: string
	readonly token: Redacted.Redacted
}

/** The `CreateLogDrainRequestOpenApi` body for an OTLP drain. */
export const otlpLogDrainBody = (spec: OtlpLogDrainSpec) => ({
	data: {
		type: "log_drain",
		attributes: {
			name: spec.name,
			description: spec.description,
			backend_type: "otlp",
			config: {
				endpoint: spec.endpoint,
				protocol: "http/protobuf",
				gzip: true,
				headers: { Authorization: `Bearer ${Redacted.value(spec.token)}` },
			},
		},
	},
})

const drainsPath = (ref: string) => `/v2/projects/${encodeURIComponent(ref)}/analytics/log-drains`

const unexpectedBody = (what: string) =>
	new SupabaseApiError({ message: `Supabase returned an unexpected body while ${what}`, kind: "upstream" })

/** `POST /v2/projects/{ref}/analytics/log-drains`. A 402 is the plan gate (Pro or higher). */
export const createLogDrain = Effect.fn("SupabaseApi.createLogDrain")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
	ref: string,
	spec: OtlpLogDrainSpec,
) {
	yield* Effect.annotateCurrentSpan({ "maple.supabase.project_ref": ref })
	const what = "creating a log drain"
	// Not retried: a 5xx after Supabase stored the drain would add a second one.
	const text = yield* supabaseClient(httpClient, baseUrl, VendorHttp.bearer(accessToken))
		.text({ method: "POST", path: drainsPath(ref), body: otlpLogDrainBody(spec), operation: what })
		.pipe(
			Effect.catchIf(
				(error) => error.status === 402,
				() => Effect.fail(new SupabasePlanRequiredError({ message: DRAINS_PLAN_MESSAGE })),
			),
		)
	const created = yield* decodeCreatedDrain(text).pipe(Effect.mapError(() => unexpectedBody(what)))
	return created.data
})

/**
 * `GET /v2/projects/{ref}/analytics/log-drains`; a drain with an undecodable shape is skipped.
 * None when the plan has no drains: Free answers 403 "does not have access to this API" (live, 2026-10-22).
 */
export const listLogDrains = Effect.fn("SupabaseApi.listLogDrains")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
	ref: string,
) {
	yield* Effect.annotateCurrentSpan({ "maple.supabase.project_ref": ref })
	const what = "listing log drains"
	const text = yield* supabaseClient(httpClient, baseUrl, VendorHttp.bearer(accessToken))
		.text({ path: drainsPath(ref), operation: what })
		.pipe(
			Effect.asSome,
			Effect.catchIf(
				(error) => error.kind === "forbidden",
				() => Effect.succeed(Option.none<string>()),
			),
		)
	if (Option.isNone(text)) {
		yield* Effect.annotateCurrentSpan({ "maple.supabase.log_drains_available": false })
		return Option.none<ReadonlyArray<SupabaseLogDrain>>()
	}
	const list = yield* decodeDrainList(text.value).pipe(Effect.mapError(() => unexpectedBody(what)))
	const drains = Arr.flatMap(list.data, (item) => Option.toArray(decodeDrain(item)))
	yield* Effect.annotateCurrentSpan({
		"maple.supabase.log_drains_listed": list.data.length,
		"maple.supabase.log_drains_skipped": list.data.length - drains.length,
	})
	return Option.some<ReadonlyArray<SupabaseLogDrain>>(drains)
})

/** `DELETE /v2/projects/{ref}/analytics/log-drains/{id}`. A 404 means it is already gone. */
export const deleteLogDrain = Effect.fn("SupabaseApi.deleteLogDrain")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
	ref: string,
	drainId: string,
) {
	yield* Effect.annotateCurrentSpan({ "maple.supabase.project_ref": ref })
	yield* supabaseClient(httpClient, baseUrl, VendorHttp.bearer(accessToken))
		.text({
			method: "DELETE",
			path: `${drainsPath(ref)}/${encodeURIComponent(drainId)}`,
			operation: "deleting a log drain",
		})
		.pipe(
			Effect.catchIf(
				(error) => error.status === 404,
				() => Effect.void,
			),
		)
})
