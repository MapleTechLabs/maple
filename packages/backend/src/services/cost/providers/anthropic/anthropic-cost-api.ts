// The slice of Anthropic's Admin API the cost source uses, through `@distilled.cloud/anthropic`: the
// organization a key belongs to, and one page of its daily cost report. Every failure is one
// `AnthropicCostApiError` whose `kind` says what the caller does next.
import * as Anthropic from "@distilled.cloud/anthropic"
import { Duration, Effect, Layer, Redacted, Schema, Array as Arr, Record as Rec } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"
import * as VendorHttp from "../../../integrations/vendor-http"
import type { CostPullWindow } from "../../CostProvider"
import { addDays } from "../../sync-plan"

export const BASE_URL = "https://api.anthropic.com"
// The SDK defaults to a newer version; the cost report's shape is pinned to this one.
const API_VERSION = "2023-06-01"
const REQUEST_TIMEOUT = Duration.seconds(30)
/** Daily buckets one page holds: the most the cost report serves. */
export const BUCKETS_PER_PAGE = 31

export class AnthropicCostApiError extends Schema.TaggedError<AnthropicCostApiError>()(
	"@maple/backend/cost/AnthropicCostApiError",
	{
		message: Schema.String,
		kind: Schema.Literals([
			"unauthorized",
			"forbidden",
			"bad_request",
			"rate_limited",
			"invalid_response",
			"upstream",
		]),
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const STATUS_BY_TAG: Record<string, number> = Rec.fromEntries(
	Arr.map(Rec.toEntries(Anthropic.HTTP_STATUS_MAP), ([status, error]) => [error.name, Number(status)]),
)

const kindOf = (tag: string): AnthropicCostApiError["kind"] =>
	tag === "Unauthorized"
		? "unauthorized"
		: tag === "Forbidden"
			? "forbidden"
			: tag === "BadRequest"
				? "bad_request"
				: tag === "TooManyRequests"
					? "rate_limited"
					: // A 2xx that is not JSON is an answer Maple cannot read, not a failed request.
						tag === "AnthropicParseError"
						? "invalid_response"
						: "upstream"

/** The status Anthropic answered, or `undefined` when the request got no answer. */
const statusOf = (error: { readonly _tag: string; readonly status?: unknown }): number | undefined =>
	HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError"
		? error.reason.response.status
		: typeof error.status === "number"
			? error.status
			: STATUS_BY_TAG[error._tag]

/** The SDK reads a 3xx body as an answer; a redirect fails here instead, with its status. */
const refuseRedirects = HttpClient.filterStatus((status) => status < 300 || status >= 400)

const toApiError = (error: { readonly _tag: string; readonly status?: unknown }) => {
	const status = statusOf(error)
	return new AnthropicCostApiError({
		message:
			status === undefined
				? `Anthropic API request failed (${error._tag})`
				: `Anthropic API answered ${status}`,
		kind: kindOf(error._tag),
		...(status === undefined ? undefined : { status }),
		cause: error,
	})
}

/**
 * One SDK call with the key over `httpClient`, its answer decoded by `schema`: the SDK does not
 * check the bodies it returns. The SDK's retries are off: the sync re-runs on its next tick.
 */
const call = <A, E extends { readonly _tag: string }, S extends Schema.Top>(
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	operation: Effect.Effect<A, E, Anthropic.AnthropicOpContext>,
	schema: S,
) => {
	const failed = (kind: AnthropicCostApiError["kind"], what: string) => (cause: unknown) =>
		Effect.fail(new AnthropicCostApiError({ message: `Anthropic API ${what}`, kind, cause }))
	return operation.pipe(
		Effect.mapError(toApiError),
		Effect.flatMap((body) =>
			Schema.decodeUnknownEffect(schema)(body).pipe(
				Effect.catchTag(
					"SchemaError",
					failed("invalid_response", "answered with a body Maple cannot read"),
				),
			),
		),
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTag("TimeoutError", failed("upstream", "request timed out")),
		// Callers show their own message; which failure it was stays on the span.
		Effect.tapError((error) =>
			Effect.annotateCurrentSpan({
				"maple.cost.anthropic.error": error.kind,
				"maple.cost.anthropic.status": error.status ?? 0,
			}),
		),
		// The key is per connection, so this cannot be hoisted into the static service graph.
		Effect.provide([
			Anthropic.credentials({ apiKey: key, apiBaseUrl: BASE_URL, version: API_VERSION }),
			Layer.succeed(HttpClient.HttpClient, refuseRedirects(httpClient)),
			Layer.succeed(Anthropic.Retry.Retry, { while: () => false }),
		]),
		// A redirect is not Anthropic answering, so the key is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		// Only an answer Maple cannot read fails the span; a refusal is the caller's to judge.
		VendorHttp.vendorSdkRequestSpan(
			"AnthropicCost.request",
			"anthropic",
			(error: AnthropicCostApiError) => (error.kind === "invalid_response" ? undefined : error.kind),
		),
	)
}

const Organization = Schema.Struct({ id: Schema.String, name: Schema.String })

/** The organization the admin key belongs to. */
export const getOrganization = (httpClient: HttpClient.HttpClient, key: Redacted.Redacted) =>
	call(httpClient, key, Anthropic.organizations.getCurrentOrganization({}), Organization)

const nullable = Schema.optionalKey(Schema.NullOr(Schema.String))

/**
 * One cost line of a day. `amount` is a decimal in cents. The enum-like fields stay plain strings:
 * a value Anthropic adds later must not fail the whole report.
 */
export const CostResult = Schema.Struct({
	amount: Schema.String,
	currency: nullable,
	cost_type: nullable,
	description: nullable,
	model: nullable,
	token_type: nullable,
	service_tier: nullable,
	context_window: nullable,
	speed: nullable,
	inference_geo: nullable,
	workspace_id: nullable,
})
export type CostResult = typeof CostResult.Type

const isoDay = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}/, { description: "Expected to start with YYYY-MM-DD" }),
)

/** One UTC day of the report, with every cost line of that day. */
export const CostBucket = Schema.Struct({
	starting_at: isoDay,
	ending_at: Schema.String,
	results: Schema.Array(CostResult),
})
export type CostBucket = typeof CostBucket.Type

const CostReportPage = Schema.Struct({
	data: Schema.Array(CostBucket),
	has_more: Schema.Boolean,
	next_page: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type CostReportPage = typeof CostReportPage.Type

/**
 * One page of the window's daily buckets by workspace and cost line, oldest first. The range ends
 * at the start of the day after the window: `ending_at` is exclusive. `page` is the previous
 * page's `next_page`.
 */
export const getCostReport = (
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	window: CostPullWindow,
	page?: string,
) =>
	call(
		httpClient,
		key,
		Anthropic.betaOrganizations.getCostReport({
			starting_at: `${window.startDay}T00:00:00Z`,
			ending_at: `${addDays(window.endDay, 1)}T00:00:00Z`,
			bucket_width: "1d",
			group_by__: ["workspace_id", "description"],
			limit: BUCKETS_PER_PAGE,
			...(page === undefined ? undefined : { page }),
		}),
		CostReportPage,
	)
