// The slice of Anthropic's Admin API the cost source uses: the organization a key belongs to, and
// one page of its daily cost report. Every failure is one `AnthropicCostApiError` whose `kind`
// says what the caller does next.
import { Duration, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { CostPullWindow } from "../../CostProvider"
import { addDays } from "../../sync-plan"

export const BASE_URL = "https://api.anthropic.com"
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

const errorKind = (status: number): AnthropicCostApiError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 400
				? "bad_request"
				: status === 429
					? "rate_limited"
					: "upstream"

const call = <S extends Schema.Top>(
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	request: HttpClientRequest.HttpClientRequest,
	schema: S,
) => {
	const failed = (kind: AnthropicCostApiError["kind"], what: string) => (cause: unknown) =>
		Effect.fail(new AnthropicCostApiError({ message: `Anthropic API ${what}`, kind, cause }))
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(
			HttpClientRequest.setHeaders(request, {
				"x-api-key": Redacted.value(key),
				"anthropic-version": API_VERSION,
			}),
		)
		if (response.status >= 300) {
			return yield* new AnthropicCostApiError({
				message: `Anthropic API answered ${response.status}`,
				kind: errorKind(response.status),
				status: response.status,
			})
		}
		// A 2xx that is not JSON is an answer Maple cannot read, not a failed request.
		const body = yield* response.json.pipe(
			Effect.catchTag(
				"HttpClientError",
				failed("invalid_response", "answered with a body that is not JSON"),
			),
		)
		return yield* Schema.decodeEffect(schema)(body)
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: failed("upstream", "request failed"),
			TimeoutError: failed("upstream", "request timed out"),
			SchemaError: failed("invalid_response", "answered with a body Maple cannot read"),
		}),
		// Callers show their own message; which failure it was stays on the span.
		Effect.tapError((error) =>
			Effect.annotateCurrentSpan({
				"maple.cost.anthropic.error": error.kind,
				"maple.cost.anthropic.status": error.status ?? 0,
			}),
		),
		// A redirect is not Anthropic answering, so the key is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "anthropic"),
	)
}

const Organization = Schema.Struct({ id: Schema.String, name: Schema.String })

/** The organization the admin key belongs to. */
export const getOrganization = (httpClient: HttpClient.HttpClient, key: Redacted.Redacted) =>
	call(httpClient, key, HttpClientRequest.get(`${BASE_URL}/v1/organizations/me`), Organization)

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
		HttpClientRequest.setUrlParams(HttpClientRequest.get(`${BASE_URL}/v1/organizations/cost_report`), {
			starting_at: `${window.startDay}T00:00:00Z`,
			ending_at: `${addDays(window.endDay, 1)}T00:00:00Z`,
			bucket_width: "1d",
			"group_by[]": ["workspace_id", "description"],
			limit: BUCKETS_PER_PAGE,
			page,
		}),
		CostReportPage,
	)
