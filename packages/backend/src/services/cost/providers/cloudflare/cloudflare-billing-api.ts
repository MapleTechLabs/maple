/**
 * The slice of Cloudflare's REST API the cost source uses: the accounts a token reads, an
 * account's daily billable usage and its subscriptions. Each call reads the status off a plain
 * request and decodes only the fields Maple reads. Failures fold into one
 * {@link CloudflareBillingError} whose `kind` says what the caller does next.
 */
import { Duration, Effect, Redacted, Schema, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

const BASE_URL = "https://api.cloudflare.com/client/v4"
const REQUEST_TIMEOUT = Duration.seconds(30)
const PAGE_SIZE = 50
const MAX_SUBSCRIPTION_PAGES = 10

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

/** Cloudflare's envelope: `result` is the answer, `result_info` the paging of a listing. */
const envelope = <S extends Schema.Top>(result: S) =>
	Schema.Struct({
		result,
		result_info: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					total_pages: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					total_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				}),
			),
		),
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
		// A redirect is not Cloudflare answering, so the token is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "cloudflare"),
	)
}

const Account = Schema.Struct({ id: Schema.String, name: Schema.String })
export type CloudflareAccount = typeof Account.Type

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

/**
 * The days before `to` of every billing period that starts in `[from, to)`: `to` is exclusive, and
 * a period that started before `from` returns nothing, whatever days of it the range covers. The
 * range is 90 days at most. One answer, no paging.
 */
export const getBillableUsage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
	range: { readonly from: string; readonly to: string },
) =>
	call(
		httpClient,
		token,
		HttpClientRequest.setUrlParams(
			HttpClientRequest.get(`${BASE_URL}/accounts/${encodeURIComponent(accountId)}/billable-usage`),
			range,
		),
		Schema.Array(UsageRow),
	).pipe(Effect.map((body) => body.result))

/** A plan or add-on the account pays a fixed fee for. Free items carry no period. */
export const Subscription = Schema.Struct({
	price: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
	frequency: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

/** Every subscription of the account, zone plans included, over as many pages as it takes. */
export const listSubscriptions = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
) =>
	Effect.gen(function* () {
		const first = yield* subscriptionsPage(httpClient, token, accountId, 1)
		const pages = Math.min(first.result_info?.total_pages ?? 1, MAX_SUBSCRIPTION_PAGES)
		const rest = yield* Effect.forEach(pages < 2 ? [] : Arr.range(2, pages), (page) =>
			Effect.map(subscriptionsPage(httpClient, token, accountId, page), (body) => body.result),
		)
		return [...first.result, ...Arr.flatten(rest)]
	})
