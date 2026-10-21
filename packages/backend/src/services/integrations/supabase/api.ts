// Supabase Management API calls made with an OAuth access token. Field names follow the OpenAPI spec
// (https://api.supabase.com/api/v1-json); extra fields are ignored so additions never break decode.
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
const send = (
	httpClient: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	what: string,
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
		Effect.retry({ schedule: TRANSIENT_RETRY, while: isTransient }),
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
	return items.flatMap((item) => Option.toArray(decodeOrganization(item)))
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
