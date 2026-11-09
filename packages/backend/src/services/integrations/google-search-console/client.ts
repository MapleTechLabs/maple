// Google Search Console API (webmasters v3): the property list and Search Analytics queries.
// Callers pass an OAuth access token; a 401 fails `SearchConsoleTokenRejectedError`, which the
// Google OAuth service's refresh-and-retry keys on.
import { Effect, Schema, Array as Arr } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const SEARCH_CONSOLE_API_BASE_URL = "https://www.googleapis.com/webmasters/v3"
/** Google's per-request maximum for Search Analytics rows. */
export const SEARCH_ANALYTICS_MAX_ROW_LIMIT = 25_000

const REQUEST_TIMEOUT = "30 seconds"

export class SearchConsoleTokenRejectedError extends Schema.TaggedError<SearchConsoleTokenRejectedError>()(
	"@maple/backend/integrations/SearchConsoleTokenRejectedError",
	{ message: Schema.String },
) {}

export class SearchConsoleApiError extends Schema.TaggedError<SearchConsoleApiError>()(
	"@maple/backend/integrations/SearchConsoleApiError",
	{
		message: Schema.String,
		/** HTTP status Google answered; absent for transport failures and timeouts. */
		status: Schema.optionalKey(Schema.Number),
	},
) {}

export const isSearchConsoleTokenRejected = (error: unknown): error is SearchConsoleTokenRejectedError =>
	Schema.is(SearchConsoleTokenRejectedError)(error)

/** One property the token can see, as Google lists it. */
export const SearchConsoleSiteEntry = Schema.Struct({
	siteUrl: Schema.String,
	/** siteOwner, siteFullUser, siteRestrictedUser or siteUnverifiedUser. */
	permissionLevel: Schema.String,
})
export type SearchConsoleSiteEntry = typeof SearchConsoleSiteEntry.Type

const SitesListResponse = Schema.Struct({
	siteEntry: Schema.optionalKey(Schema.Array(SearchConsoleSiteEntry)),
})

export const SearchAnalyticsDimension = Schema.Literals([
	"date",
	"hour",
	"query",
	"page",
	"country",
	"device",
	"searchAppearance",
])
export type SearchAnalyticsDimension = typeof SearchAnalyticsDimension.Type

/** `final` is finalized data only; `all` includes the fresh, still-changing days. */
export const SearchAnalyticsDataState = Schema.Literals(["final", "all", "hourly_all"])
export type SearchAnalyticsDataState = typeof SearchAnalyticsDataState.Type

export interface SearchAnalyticsQuery {
	/** Inclusive, YYYY-MM-DD in Pacific time, as Google reports days. */
	readonly startDate: string
	readonly endDate: string
	readonly dimensions: ReadonlyArray<SearchAnalyticsDimension>
	/** Zero-based offset of the first row; pages advance it by the row limit. */
	readonly startRow: number
	readonly dataState: SearchAnalyticsDataState
	/** Defaults to Google's maximum, `SEARCH_ANALYTICS_MAX_ROW_LIMIT`. */
	readonly rowLimit?: number
}

export const SearchAnalyticsRow = Schema.Struct({
	/** One value per requested dimension, in request order. */
	keys: Schema.optionalKey(Schema.Array(Schema.String)),
	clicks: Schema.Number,
	impressions: Schema.Number,
	ctr: Schema.Number,
	position: Schema.Number,
})
export type SearchAnalyticsRow = typeof SearchAnalyticsRow.Type

const SearchAnalyticsResponse = Schema.Struct({
	rows: Schema.optionalKey(Schema.Array(SearchAnalyticsRow)),
	responseAggregationType: Schema.optionalKey(Schema.String),
})

export interface SearchAnalyticsPage {
	readonly rows: ReadonlyArray<SearchAnalyticsRow>
	/** The next page's `startRow`, or null when this page was the last. */
	readonly nextStartRow: number | null
}

const decodeSites = Schema.decodeUnknownEffect(Schema.fromJsonString(SitesListResponse))
const decodeSearchAnalytics = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchAnalyticsResponse))

/** The JSON body Google expects for one Search Analytics page. */
export const searchAnalyticsRequestBody = (query: SearchAnalyticsQuery) => ({
	startDate: query.startDate,
	endDate: query.endDate,
	dimensions: query.dimensions,
	rowLimit: query.rowLimit ?? SEARCH_ANALYTICS_MAX_ROW_LIMIT,
	startRow: query.startRow,
	dataState: query.dataState,
})

/** The Search Analytics endpoint of one property; the site URL is a single path segment. */
export const searchAnalyticsUrl = (siteUrl: string): string =>
	`${SEARCH_CONSOLE_API_BASE_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`

const execute = Effect.fn("SearchConsole.execute")(function* (
	httpClient: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
) {
	const { status, text } = yield* Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		return { status: response.status, text: yield* response.text }
	}).pipe(
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(new SearchConsoleApiError({ message: "Search Console request timed out" })),
		}),
		Effect.catchTag("HttpClientError", (error) =>
			Effect.fail(
				new SearchConsoleApiError({ message: `Search Console request failed: ${error.message}` }),
			),
		),
	)
	yield* Effect.annotateCurrentSpan("http.response.status_code", status)
	if (status === 401) {
		return yield* new SearchConsoleTokenRejectedError({
			message: "Google rejected the access token. Reconnect Google Search Console.",
		})
	}
	if (status === 403) {
		return yield* new SearchConsoleApiError({
			message: "Google denied access to this Search Console property",
			status,
		})
	}
	if (status === 429) {
		return yield* new SearchConsoleApiError({ message: "Search Console quota exceeded", status })
	}
	if (status < 200 || status >= 300) {
		return yield* new SearchConsoleApiError({ message: `Search Console returned ${status}`, status })
	}
	return text
})

const bearer = (accessToken: string) => ({
	authorization: `Bearer ${accessToken}`,
	accept: "application/json",
})

/** Every property the token's Google account can see, with its permission level. */
export const listSites = Effect.fn("SearchConsole.listSites", { kind: "client" })(function* (
	httpClient: HttpClient.HttpClient,
	accessToken: string,
) {
	yield* Effect.annotateCurrentSpan({ "peer.service": "google-search-console" })
	const text = yield* execute(
		httpClient,
		HttpClientRequest.get(`${SEARCH_CONSOLE_API_BASE_URL}/sites`, { headers: bearer(accessToken) }),
	)
	const body = yield* decodeSites(text).pipe(
		Effect.mapError(
			() => new SearchConsoleApiError({ message: "Search Console returned an unexpected site list" }),
		),
	)
	return body.siteEntry ?? []
})

/** One page of Search Analytics rows for a property. */
export const querySearchAnalytics = Effect.fn("SearchConsole.querySearchAnalytics", { kind: "client" })(
	function* (
		httpClient: HttpClient.HttpClient,
		accessToken: string,
		siteUrl: string,
		query: SearchAnalyticsQuery,
	) {
		const body = searchAnalyticsRequestBody(query)
		yield* Effect.annotateCurrentSpan({
			"peer.service": "google-search-console",
			"maple.search_console.start_row": body.startRow,
			"maple.search_console.dimensions": Arr.join(query.dimensions, ","),
		})
		const request = HttpClientRequest.post(searchAnalyticsUrl(siteUrl), {
			headers: { ...bearer(accessToken), "content-type": "application/json" },
		}).pipe(HttpClientRequest.bodyJsonUnsafe(body))
		const text = yield* execute(httpClient, request)
		const response = yield* decodeSearchAnalytics(text).pipe(
			Effect.mapError(
				() =>
					new SearchConsoleApiError({
						message: "Search Console returned an unexpected Search Analytics payload",
					}),
			),
		)
		const rows = response.rows ?? []
		yield* Effect.annotateCurrentSpan("maple.search_console.rows", rows.length)
		return {
			rows,
			// A short page is the last one; a full page may have more behind it.
			nextStartRow: rows.length < body.rowLimit ? null : body.startRow + rows.length,
		} satisfies SearchAnalyticsPage
	},
)
