// The slice of Cloudflare's REST API the cost source uses: the accounts a token reads, an account's
// daily billable usage and its subscriptions. Each call reads the status off a plain request, and
// every failure is one `CloudflareBillingError` whose `kind` says what the caller does next.
import { Duration, Effect, Redacted, Schema, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { CostPullWindow } from "../../CostProvider"
import { addDays } from "../../sync-plan"

export const BASE_URL = "https://api.cloudflare.com/client/v4"
const REQUEST_TIMEOUT = Duration.seconds(30)
const PAGE_SIZE = 50
const MAX_SUBSCRIPTION_PAGES = 10

/** What a save and a pull both say about an account `billable-usage/info` reports as not covered. */
export const NOT_COVERED =
	"Cloudflare has no usage-based billing data for this account. Accounts on an enterprise contract are not supported yet."

export class CloudflareBillingError extends Schema.TaggedError<CloudflareBillingError>()(
	"@maple/backend/cost/CloudflareBillingError",
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

const errorKind = (status: number): CloudflareBillingError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 400
				? "bad_request"
				: status === 429
					? "rate_limited"
					: "upstream"

const ResultInfo = Schema.Struct({
	per_page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	total_pages: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	total_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})

/**
 * Cloudflare's envelope: `result` is the answer, `result_info` the paging of a listing. A 200 that
 * does not say `success: true` is not an answer: read as one, its empty result would store empty days.
 */
const envelope = <S extends Schema.Top>(result: S) =>
	Schema.Struct({
		success: Schema.Literal(true),
		result,
		result_info: Schema.optionalKey(Schema.NullOr(ResultInfo)),
	})

/** A listing Maple holds only part of: stored as it is, the missing rest would read as no cost. */
const partial = (what: string, held: number, total: number) =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			"maple.cost.cloudflare.error": "partial_listing",
			"maple.cost.cloudflare.listed": total,
			"maple.cost.cloudflare.read": held,
		})
		return yield* new CloudflareBillingError({
			message: `Cloudflare lists ${total} ${what} and Maple read ${held}`,
			kind: "invalid_response",
		})
	})

const call = <S extends Schema.Top>(
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	request: HttpClientRequest.HttpClientRequest,
	result: S,
) => {
	const failed = (kind: CloudflareBillingError["kind"], what: string) => (cause: unknown) =>
		Effect.fail(new CloudflareBillingError({ message: `Cloudflare API ${what}`, kind, cause }))
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(HttpClientRequest.bearerToken(request, token))
		if (response.status >= 300) {
			return yield* new CloudflareBillingError({
				message: `Cloudflare API answered ${response.status}`,
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
		return yield* Schema.decodeUnknownEffect(envelope(result))(body)
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
				"maple.cost.cloudflare.error": error.kind,
				"maple.cost.cloudflare.status": error.status ?? 0,
			}),
		),
		// A redirect is not Cloudflare answering, so the token is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "cloudflare"),
	)
}

const Account = Schema.Struct({ id: Schema.String, name: Schema.String })

/**
 * The accounts the token can see, and how many there are in all. A token limited to one account
 * lists exactly that one. A token Cloudflare does not know answers 403 here, not 401.
 */
export const listAccounts = (httpClient: HttpClient.HttpClient, token: Redacted.Redacted) =>
	call(
		httpClient,
		token,
		HttpClientRequest.setUrlParam(
			HttpClientRequest.get(`${BASE_URL}/accounts`),
			"per_page",
			`${PAGE_SIZE}`,
		),
		Schema.Array(Account),
	).pipe(
		Effect.map((body) => ({
			accounts: body.result,
			total: Math.max(body.result.length, body.result_info?.total_count ?? 0),
		})),
	)

const UsageInfo = Schema.Struct({ covered: Schema.Boolean })

/** Whether the account has usage-based billing data at all: not so on an enterprise contract. */
export const getBillableUsageInfo = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
) =>
	call(
		httpClient,
		token,
		HttpClientRequest.get(`${BASE_URL}/accounts/${encodeURIComponent(accountId)}/billable-usage/info`),
		UsageInfo,
	).pipe(Effect.map((body) => body.result))

const isoDay = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}/, { description: "Expected to start with YYYY-MM-DD" }),
)

/** One UTC day of one priced metric. Money is in `BillingCurrency`; most rows bill 0. */
export const UsageRow = Schema.Struct({
	ServiceName: Schema.String,
	ServiceFamilyName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	ChargePeriodStart: isoDay,
	BillingCurrency: Schema.String,
	BilledCost: Schema.Number,
	EffectiveCost: Schema.Number,
	ListCost: Schema.Number,
	ConsumedQuantity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	ConsumedUnit: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type UsageRow = typeof UsageRow.Type

/** A billing period is 31 days at most: a range starting this long before a day includes its period's start. */
const PERIOD_LEAD_DAYS = 31

/**
 * Every usage row of the window's days. Cloudflare answers the days before `to` of each billing
 * period that starts in `[from, to)`, so the range starts a period before the window and ends the
 * day after it, and the answer also holds days before the window. 90 days at most, no paging.
 */
export const getBillableUsage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
	window: CostPullWindow,
) =>
	call(
		httpClient,
		token,
		HttpClientRequest.setUrlParams(
			HttpClientRequest.get(`${BASE_URL}/accounts/${encodeURIComponent(accountId)}/billable-usage`),
			{ from: addDays(window.startDay, -PERIOD_LEAD_DAYS), to: addDays(window.endDay, 1) },
		),
		Schema.Array(UsageRow),
	).pipe(
		// The answer has no paging today. One that starts to page must not be read as the whole window.
		Effect.flatMap((body) => {
			const info = body.result_info
			const total = info?.total_count ?? body.result.length
			return (info?.total_pages ?? 1) > 1 || total > body.result.length
				? partial("usage rows", body.result.length, total)
				: Effect.succeed(body.result)
		}),
	)

/** A plan or add-on the account pays a fixed fee for. Free items carry no period. */
export const Subscription = Schema.Struct({
	price: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
	frequency: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** `Paid`, `Trial`, `Cancelled`, `Failed`, `Expired` and others. */
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	current_period_start: Schema.optionalKey(Schema.NullOr(isoDay)),
	created_date: Schema.optionalKey(Schema.NullOr(isoDay)),
	rate_plan: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ public_name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
	product: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
	zone: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
})
export type Subscription = typeof Subscription.Type

const subscriptionsPage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
	page: number,
) =>
	call(
		httpClient,
		token,
		HttpClientRequest.setUrlParams(
			HttpClientRequest.get(`${BASE_URL}/accounts/${encodeURIComponent(accountId)}/subscriptions`),
			{ per_page: `${PAGE_SIZE}`, page: `${page}` },
		),
		Schema.Array(Subscription),
	)

/**
 * Every subscription of the account, zone plans included. The page count comes from `total_pages`,
 * or from `total_count` where the listing does not say. A list Maple cannot read whole fails:
 * part of it would under-count the fees.
 */
export const listSubscriptions = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
) =>
	Effect.gen(function* () {
		const first = yield* subscriptionsPage(httpClient, token, accountId, 1)
		const info = first.result_info
		const total = info?.total_count ?? null
		const perPage = info?.per_page ?? PAGE_SIZE
		const stated = info?.total_pages ?? (total === null ? null : Math.ceil(total / Math.max(1, perPage)))
		// With neither figure, a page that is not full is the whole list. A full one may be part of it.
		const pages = stated ?? (first.result.length < perPage ? 1 : null)
		if (pages === null || pages > MAX_SUBSCRIPTION_PAGES) {
			return yield* partial("subscriptions", first.result.length, total ?? first.result.length)
		}
		const rest = yield* Effect.forEach(pages < 2 ? [] : Arr.range(2, pages), (page) =>
			Effect.map(subscriptionsPage(httpClient, token, accountId, page), (body) => body.result),
		)
		const subscriptions = [...first.result, ...Arr.flatten(rest)]
		if (total !== null && subscriptions.length < total) {
			return yield* partial("subscriptions", subscriptions.length, total)
		}
		return subscriptions
	})
