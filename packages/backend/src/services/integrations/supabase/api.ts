// Supabase Management API calls made with an OAuth access token. Field names follow the OpenAPI specs
// (https://api.supabase.com/api/v1-json, v2-json for log drains); extra fields are ignored so
// additions never break decode.
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Duration, Effect, Option, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

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

const upstreamDetail = (text: string) =>
	Option.match(decodeErrorBody(text), {
		onNone: () => "",
		onSome: (body) => {
			const detail = "error" in body ? (body.error.description ?? body.error.message) : body.message
			return detail === undefined ? "" : `: ${detail.slice(0, 300)}`
		},
	})

/** `retry-after`, else `x-ratelimit-reset` (seconds until the window resets). */
const retryAfterSeconds = (headers: Readonly<Record<string, string | undefined>>) => {
	const header = headers["retry-after"] ?? headers["x-ratelimit-reset"]
	const seconds = header === undefined ? Number.NaN : Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : undefined
}

const TRANSIENT_RETRY = Schedule.max([
	Schedule.jittered(Schedule.exponential("500 millis")),
	Schedule.recurs(2),
])

const isTransient = (error: SupabaseApiError) =>
	error.kind === "upstream" && (error.status === undefined || error.status >= 500)

/** Execute one request; any non-2xx becomes a classified {@link SupabaseApiError}. */
export const send = (
	httpClient: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	what: string,
	// A create is not retried: a 5xx after Supabase stored it would add a second drain.
	options: { readonly retry: boolean } = { retry: true },
) =>
	Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		const text = yield* response.text
		const status = response.status
		if (status >= 200 && status < 300) return text
		if (status === 401) {
			return yield* new SupabaseApiError({
				message: `Supabase rejected the access token while ${what}`,
				kind: "unauthorized",
				status,
			})
		}
		if (status === 403) {
			return yield* new SupabaseApiError({
				message: `Supabase denied ${what}${upstreamDetail(text) || ": the OAuth app may be missing a scope"}`,
				kind: "forbidden",
				status,
			})
		}
		if (status === 429) {
			return yield* new SupabaseApiError({
				message: `Supabase rate limited ${what}`,
				kind: "rate_limited",
				status,
				...retryAfterSeconds(response.headers),
			})
		}
		return yield* new SupabaseApiError({
			message: `Supabase answered ${status} while ${what}${upstreamDetail(text)}`,
			kind: "upstream",
			status,
		})
	}).pipe(
		Effect.catchTag("HttpClientError", (error) =>
			Effect.fail(
				new SupabaseApiError({
					message: `Supabase request failed while ${what}: ${error.message}`,
					kind: "upstream",
				}),
			),
		),
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(
					new SupabaseApiError({ message: `Supabase timed out while ${what}`, kind: "upstream" }),
				),
		}),
		Effect.retry({ schedule: TRANSIENT_RETRY, while: (error) => options.retry && isTransient(error) }),
		Effect.annotateSpans("peer.service", "supabase"),
	)

const getArray = (httpClient: HttpClient.HttpClient, url: string, accessToken: string, what: string) =>
	send(
		httpClient,
		HttpClientRequest.get(url).pipe(
			HttpClientRequest.bearerToken(accessToken),
			HttpClientRequest.acceptJson,
		),
		what,
	).pipe(
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
		`${baseUrl}/v1/organizations`,
		accessToken,
		"listing organizations",
	)
	const organizations = items.flatMap((item) => Option.toArray(decodeOrganization(item)))
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
	const items = yield* getArray(httpClient, `${baseUrl}/v1/projects`, accessToken, "listing projects")
	const projects = items.flatMap((item) => Option.toArray(decodeProject(item)))
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
		readonly clientSecret: Redacted.Redacted<string>
		readonly refreshToken: string
	},
) {
	const request = HttpClientRequest.post(`${baseUrl}/v1/oauth/revoke`).pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.bodyJsonUnsafe({
			client_id: params.clientId,
			client_secret: Redacted.value(params.clientSecret),
			refresh_token: params.refreshToken,
		}),
	)
	yield* send(httpClient, request, "revoking the authorization")
})

/** A `log_drain` resource (`ListLogDrainsResponse_Output.data[]`); the config stays opaque here. */
const LogDrainSchema = Schema.Struct({
	id: Schema.String,
	attributes: Schema.Struct({
		name: Schema.String,
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
	readonly token: Redacted.Redacted<string>
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

const drainsUrl = (baseUrl: string, ref: string) =>
	`${baseUrl}/v2/projects/${encodeURIComponent(ref)}/analytics/log-drains`

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
	const request = HttpClientRequest.post(drainsUrl(baseUrl, ref)).pipe(
		HttpClientRequest.bearerToken(accessToken),
		HttpClientRequest.acceptJson,
		HttpClientRequest.bodyJsonUnsafe(otlpLogDrainBody(spec)),
	)
	const text = yield* send(httpClient, request, what, { retry: false }).pipe(
		Effect.catchIf(
			(error) => error.status === 402,
			() =>
				Effect.fail(
					new SupabasePlanRequiredError({
						message: "Log drains need a Supabase Pro plan or higher.",
					}),
				),
		),
	)
	const created = yield* decodeCreatedDrain(text).pipe(Effect.mapError(() => unexpectedBody(what)))
	return created.data
})

/** `GET /v2/projects/{ref}/analytics/log-drains`; a drain with an undecodable shape is skipped. */
export const listLogDrains = Effect.fn("SupabaseApi.listLogDrains")(function* (
	httpClient: HttpClient.HttpClient,
	baseUrl: string,
	accessToken: string,
	ref: string,
) {
	yield* Effect.annotateCurrentSpan({ "maple.supabase.project_ref": ref })
	const what = "listing log drains"
	const text = yield* send(
		httpClient,
		HttpClientRequest.get(drainsUrl(baseUrl, ref)).pipe(
			HttpClientRequest.bearerToken(accessToken),
			HttpClientRequest.acceptJson,
		),
		what,
	)
	const list = yield* decodeDrainList(text).pipe(Effect.mapError(() => unexpectedBody(what)))
	const drains = list.data.flatMap((item) => Option.toArray(decodeDrain(item)))
	yield* Effect.annotateCurrentSpan({
		"maple.supabase.log_drains_listed": list.data.length,
		"maple.supabase.log_drains_skipped": list.data.length - drains.length,
	})
	return drains
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
	const request = HttpClientRequest.delete(
		`${drainsUrl(baseUrl, ref)}/${encodeURIComponent(drainId)}`,
	).pipe(HttpClientRequest.bearerToken(accessToken), HttpClientRequest.acceptJson)
	yield* send(httpClient, request, "deleting a log drain").pipe(
		Effect.catchIf(
			(error) => error.status === 404,
			() => Effect.void,
		),
	)
})
