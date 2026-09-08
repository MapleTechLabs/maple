// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * Thin wrapper over the two Google Analytics 4 REST surfaces the collector needs:
 *
 * - **Admin API** `accountSummaries.list` — property discovery. One call enumerates every account
 *   the grant covers and the properties under each, so there is no per-account fan-out.
 * - **Data API** `properties/{id}:runReport` — the actual numbers, one call per (property, dataset).
 *
 * Unlike {@link CloudflareApi} this is NOT a lazy dynamic-import facade. That indirection exists
 * purely because the distilled Cloudflare SDK is a ~2.4MB module graph; GA4 is plain REST over the
 * ambient `HttpClient`, so there is nothing heavy to defer and the extra hop would only obscure.
 *
 * Error mapping is the contract the poll loop reads:
 * - 401, and 403 whose reason names the credential, are {@link IntegrationsRevokedError} — the
 *   grant is gone and the connection must be stamped revoked.
 * - 403 `RESOURCE_EXHAUSTED`-shaped quota denials and 429 keep `status` on
 *   {@link IntegrationsUpstreamError} so the caller can hold its lease through a backoff instead
 *   of re-depleting the property's token budget.
 * - Everything else is a plain upstream failure: the watermark simply does not advance.
 */
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

/** GA4 quota denial — the caller backs off rather than retrying within the tick. */
export const GA_QUOTA_STATUS = 429

const PropertySummary = Schema.Struct({
	// "properties/123456789"
	property: Schema.String,
	displayName: Schema.optionalKey(Schema.String),
	propertyType: Schema.optionalKey(Schema.String),
})

const AccountSummary = Schema.Struct({
	displayName: Schema.optionalKey(Schema.String),
	propertySummaries: Schema.optionalKey(Schema.Array(PropertySummary)),
})

const AccountSummariesResponse = Schema.Struct({
	accountSummaries: Schema.optionalKey(Schema.Array(AccountSummary)),
	nextPageToken: Schema.optionalKey(Schema.String),
})

const MetricHeader = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	type: Schema.optionalKey(Schema.String),
})

const ReportValue = Schema.Struct({ value: Schema.optionalKey(Schema.String) })

const ReportRow = Schema.Struct({
	dimensionValues: Schema.optionalKey(Schema.Array(ReportValue)),
	metricValues: Schema.optionalKey(Schema.Array(ReportValue)),
})

/**
 * `rows` is absent, not empty, when a report matches nothing — hence `optionalKey` throughout.
 * `dimensionHeaders`/`metricHeaders` echo the request order, which is what lets the mapper pair a
 * row's positional values back to names without trusting our own request-building twice.
 */
const RunReportResponse = Schema.Struct({
	dimensionHeaders: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.optionalKey(Schema.String) }))),
	metricHeaders: Schema.optionalKey(Schema.Array(MetricHeader)),
	rows: Schema.optionalKey(Schema.Array(ReportRow)),
	rowCount: Schema.optionalKey(Schema.Number),
})

export type GoogleAnalyticsRunReportResponse = typeof RunReportResponse.Type

const decodeAccountSummaries = Schema.decodeUnknown(AccountSummariesResponse)
const decodeRunReport = Schema.decodeUnknown(RunReportResponse)

export interface GoogleAnalyticsProperty {
	/** Bare id ("123456789"), with the API's "properties/" resource prefix stripped. */
	readonly propertyId: string
	readonly propertyName: string | null
	readonly accountName: string | null
}

/** One `runReport` request, in the Data API's own vocabulary. */
export interface RunReportRequest {
	readonly dimensions: ReadonlyArray<string>
	readonly metrics: ReadonlyArray<string>
	/** Inclusive `YYYY-MM-DD` bounds, in the property's configured reporting timezone. */
	readonly startDate: string
	readonly endDate: string
	readonly limit?: number
	/** Descending order-by on this metric — how a breakdown dataset takes its top N. */
	readonly orderByMetric?: string
	/** Sent verbatim as the Data API's `dimensionFilter`. */
	readonly dimensionFilter?: unknown
}

const upstream = (message: string, status?: number, cause?: unknown) =>
	new IntegrationsUpstreamError({
		message,
		...(status === undefined ? {} : { status }),
		...(cause === undefined ? {} : { cause }),
	})

/**
 * Google's error envelope: `{ error: { code, status, message } }`. `status` is the symbolic
 * enum ("PERMISSION_DENIED", "RESOURCE_EXHAUSTED"), which is what distinguishes a dead grant
 * from a quota denial — both arrive as HTTP 403.
 */
const errorStatusOf = (text: string): string | null => {
	try {
		const parsed = JSON.parse(text) as { error?: { status?: unknown } }
		const status = parsed.error?.status
		return typeof status === "string" ? status : null
	} catch {
		return null
	}
}

const classifyFailure = (httpStatus: number, text: string, label: string) => {
	const symbolic = errorStatusOf(text)
	const snippet = text.slice(0, 300)
	// A 403 is overloaded: quota denials and dead grants share it. Only the credential-shaped
	// ones may stamp the connection revoked — treating a quota denial as revoked would
	// disconnect an org for being popular.
	if (httpStatus === 401 || (httpStatus === 403 && symbolic !== "RESOURCE_EXHAUSTED")) {
		return new IntegrationsRevokedError({
			message: `Google Analytics ${label} rejected the stored grant (${httpStatus}${symbolic ? ` ${symbolic}` : ""}) — reconnect required`,
		})
	}
	if (httpStatus === 429 || symbolic === "RESOURCE_EXHAUSTED") {
		return upstream(
			`Google Analytics ${label} quota exhausted (${httpStatus}${symbolic ? ` ${symbolic}` : ""})`,
			GA_QUOTA_STATUS,
		)
	}
	return upstream(`Google Analytics ${label} returned ${httpStatus}: ${snippet}`, httpStatus)
}

const authorized = (request: HttpClientRequest.HttpClientRequest, accessToken: string) =>
	request.pipe(
		HttpClientRequest.setHeaders({
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		}),
	)

/**
 * Every GA4 property the grant can see, across every account it covers. Paginated: the Admin API
 * caps `pageSize` at 200 and a single agency grant can exceed that, so the loop is not optional.
 */
export const listProperties = Effect.fn("GoogleAnalyticsApi.listProperties")(function* (options: {
	readonly accessToken: string
	readonly adminBaseUrl: string
	/** Safety stop so a pathological `nextPageToken` cycle cannot spin the tick. */
	readonly maxPages?: number
}) {
	const httpClient = yield* HttpClient.HttpClient
	const properties: Array<GoogleAnalyticsProperty> = []
	let pageToken: string | undefined
	const maxPages = options.maxPages ?? 10

	for (let page = 0; page < maxPages; page++) {
		const url = new URL(`${options.adminBaseUrl.replace(/\/+$/, "")}/accountSummaries`)
		url.searchParams.set("pageSize", "200")
		if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken)

		const response = yield* httpClient
			.execute(authorized(HttpClientRequest.get(url.toString()), options.accessToken))
			.pipe(
				Effect.annotateSpans("peer.service", "google-analytics-admin"),
				Effect.catchTag("HttpClientError", (error) =>
					Effect.fail(upstream(`Google Analytics admin request failed: ${error.message}`, undefined, error)),
				),
			)

		if (response.status >= 300) {
			const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
			return yield* Effect.fail(classifyFailure(response.status, text, "Admin API"))
		}

		const json = yield* response.json.pipe(
			Effect.mapError(() => upstream("Google Analytics Admin API returned a non-JSON response")),
		)
		const decoded = yield* decodeAccountSummaries(json).pipe(
			Effect.mapError(() => upstream("Google Analytics Admin API returned an unexpected payload")),
		)

		for (const account of decoded.accountSummaries ?? []) {
			for (const summary of account.propertySummaries ?? []) {
				// "properties/123456789" → "123456789". A name that does not carry the prefix is
				// not a property resource we understand, so it is skipped rather than guessed at.
				const propertyId = summary.property.startsWith("properties/")
					? summary.property.slice("properties/".length)
					: null
				if (propertyId === null || propertyId === "") continue
				properties.push({
					propertyId,
					propertyName: summary.displayName ?? null,
					accountName: account.displayName ?? null,
				})
			}
		}

		pageToken = decoded.nextPageToken
		if (pageToken === undefined || pageToken === "") break
	}

	return properties
})

/** One Data API `runReport` against a single property. */
export const runReport = Effect.fn("GoogleAnalyticsApi.runReport")(function* (options: {
	readonly accessToken: string
	readonly dataBaseUrl: string
	readonly propertyId: string
	readonly request: RunReportRequest
}) {
	const httpClient = yield* HttpClient.HttpClient
	const { request } = options
	const body = {
		dimensions: request.dimensions.map((name) => ({ name })),
		metrics: request.metrics.map((name) => ({ name })),
		dateRanges: [{ startDate: request.startDate, endDate: request.endDate }],
		...(request.limit === undefined ? {} : { limit: String(request.limit) }),
		...(request.orderByMetric === undefined
			? {}
			: { orderBys: [{ metric: { metricName: request.orderByMetric }, desc: true }] }),
		...(request.dimensionFilter === undefined ? {} : { dimensionFilter: request.dimensionFilter }),
		// Google's own "(other)" bucket silently replaces the tail once a report exceeds its
		// cardinality limit. Asking for the totals row would not tell us it happened, so instead
		// the caller caps with `limit` and folds its own explicit remainder — see the mapper.
		keepEmptyRows: false,
	}

	const url = `${options.dataBaseUrl.replace(/\/+$/, "")}/properties/${options.propertyId}:runReport`
	const response = yield* httpClient
		.execute(
			authorized(HttpClientRequest.post(url), options.accessToken).pipe(
				HttpClientRequest.bodyJsonUnsafe(body),
			),
		)
		.pipe(
			Effect.annotateSpans("peer.service", "google-analytics-data"),
			Effect.catchTag("HttpClientError", (error) =>
				Effect.fail(upstream(`Google Analytics data request failed: ${error.message}`, undefined, error)),
			),
		)

	if (response.status >= 300) {
		const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
		return yield* Effect.fail(classifyFailure(response.status, text, "Data API"))
	}

	const json = yield* response.json.pipe(
		Effect.mapError(() => upstream("Google Analytics Data API returned a non-JSON response")),
	)
	return yield* decodeRunReport(json).pipe(
		Effect.mapError(() => upstream("Google Analytics Data API returned an unexpected payload")),
	)
})

export type GoogleAnalyticsApiError = IntegrationsUpstreamError | IntegrationsRevokedError
