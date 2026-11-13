// The slice of OpenAI's Administration API the cost source uses: the organization's daily costs,
// read with an Admin API key. Every failure is one `OpenAiCostsError` whose `kind` says what the
// caller does next.
import { Duration, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export const COSTS_URL = "https://api.openai.com/v1/organization/costs"
const REQUEST_TIMEOUT = Duration.seconds(30)
/** The most daily buckets one page holds. */
export const MAX_BUCKETS_PER_PAGE = 180

export class OpenAiCostsError extends Schema.TaggedError<OpenAiCostsError>()(
	"@maple/backend/cost/OpenAiCostsError",
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

const errorKind = (status: number): OpenAiCostsError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 400
				? "bad_request"
				: status === 429
					? "rate_limited"
					: "upstream"

/** One charge of a day. A result without an amount is not a charge. */
export const CostResult = Schema.Struct({
	amount: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				value: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	),
	line_item: Schema.optionalKey(Schema.NullOr(Schema.String)),
	project_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** Not in the documented schema, but on real answers; the `openai-organization` header comes first. */
	organization_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	quantity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	quantity_unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type CostResult = typeof CostResult.Type

/** One UTC day, `start_time` and `end_time` in Unix seconds. */
export const CostBucket = Schema.Struct({
	start_time: Schema.Number,
	end_time: Schema.Number,
	results: Schema.Array(CostResult),
})
export type CostBucket = typeof CostBucket.Type

const CostPage = Schema.Struct({
	data: Schema.Array(CostBucket),
	has_more: Schema.Boolean,
	next_page: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export interface CostsQuery {
	/** Unix seconds, inclusive. */
	readonly startTime: number
	/** Unix seconds, exclusive. */
	readonly endTime: number
	readonly groupBy: ReadonlyArray<"project_id" | "line_item">
}

const costsPage = (
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	query: CostsQuery,
	page: string | undefined,
) => {
	const failed = (kind: OpenAiCostsError["kind"], what: string) => (cause: unknown) =>
		Effect.fail(new OpenAiCostsError({ message: `OpenAI API ${what}`, kind, cause }))
	const request = HttpClientRequest.setUrlParams(HttpClientRequest.get(COSTS_URL), {
		start_time: query.startTime,
		end_time: query.endTime,
		bucket_width: "1d",
		// Bracketed, as OpenAI's own SDKs encode an array parameter.
		"group_by[]": query.groupBy,
		limit: MAX_BUCKETS_PER_PAGE,
		page,
	})
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(HttpClientRequest.bearerToken(request, key))
		if (response.status >= 300) {
			return yield* new OpenAiCostsError({
				message: `OpenAI API answered ${response.status}`,
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
		const page = yield* Schema.decodeUnknownEffect(CostPage)(body)
		// Documented as the organization associated with the request.
		const organization = response.headers["openai-organization"]
		return {
			page,
			organization: organization === undefined || organization === "" ? undefined : organization,
		}
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
				"maple.cost.openai.error": error.kind,
				"maple.cost.openai.status": error.status ?? 0,
			}),
		),
		// A redirect is not OpenAI answering, so the key is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "openai"),
	)
}

export interface CostListing {
	readonly buckets: ReadonlyArray<CostBucket>
	readonly pages: number
	/** False when more pages were left than `maxPages` allowed. */
	readonly complete: boolean
	/** The `openai-organization` header of the first page, when OpenAI sent one. */
	readonly organization: string | undefined
}

/** Every bucket of the query, following `next_page` one page at a time up to `maxPages`. */
export const listCosts = (
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	query: CostsQuery,
	maxPages: number,
) => {
	const from = (
		page: string | undefined,
		held: ReadonlyArray<CostBucket>,
		pages: number,
		organization: string | undefined,
	): Effect.Effect<CostListing, OpenAiCostsError> =>
		Effect.flatMap(costsPage(httpClient, key, query, page), (answer) => {
			const body = answer.page
			const buckets = [...held, ...body.data]
			const read = pages + 1
			const org = organization ?? answer.organization
			if (!body.has_more)
				return Effect.succeed({ buckets, pages: read, complete: true, organization: org })
			const next = body.next_page ?? ""
			// More to read and no cursor to read it with, or the same page again: reading on would only
			// repeat it, so what was read is only part of the costs.
			if (next === "" || next === page) {
				return Effect.fail(
					new OpenAiCostsError({
						message: "OpenAI API says there is more and gives no next page",
						kind: "invalid_response",
					}),
				)
			}
			return read >= maxPages
				? Effect.succeed({ buckets, pages: read, complete: false, organization: org })
				: from(next, buckets, read, org)
		})
	return from(undefined, [], 0, undefined)
}
