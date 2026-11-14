// Google Search Console API (webmasters v3): the property list and Search Analytics queries.
// Callers pass an OAuth access token; a 401 fails `SearchConsoleTokenRejectedError`, which the
// Google OAuth service's refresh-and-retry keys on.
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../vendor-http"

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

/** The JSON body Google expects for one Search Analytics page. */
export const searchAnalyticsRequestBody = (query: SearchAnalyticsQuery) => ({
	startDate: query.startDate,
	endDate: query.endDate,
	dimensions: query.dimensions,
	rowLimit: query.rowLimit ?? SEARCH_ANALYTICS_MAX_ROW_LIMIT,
	startRow: query.startRow,
	dataState: query.dataState,
})

/** The Search Analytics path of one property; the site URL is a single path segment. */
const searchAnalyticsPath = (siteUrl: string) => `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`

/** Google's error body: `{ error: { code, message, status } }`. */
const GoogleErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
const decodeGoogleError = Schema.decodeUnknownOption(Schema.fromJsonString(GoogleErrorBody))

const googleDetail = (body: string) =>
	Option.match(decodeGoogleError(body), {
		onNone: () => undefined,
		onSome: (decoded) => decoded.error.message,
	})

type SearchConsoleError = SearchConsoleTokenRejectedError | SearchConsoleApiError

/** A failed call in the words each status has always had; `unexpected` names a body that does not decode. */
const toSearchConsoleError =
	(unexpected: string) =>
	(error: VendorHttp.VendorHttpError): SearchConsoleError => {
		const status = error.status === undefined ? undefined : { status: error.status }
		const detail = error.detail === undefined ? "" : `: ${Str.slice(0, 300)(error.detail)}`
		switch (error.kind) {
			case "unauthorized":
				return new SearchConsoleTokenRejectedError({
					message: "Google rejected the access token. Reconnect Google Search Console.",
				})
			case "forbidden":
				return new SearchConsoleApiError({
					message: `Google denied access to this Search Console property${detail}`,
					...status,
				})
			case "rate_limited":
				return new SearchConsoleApiError({ message: "Search Console quota exceeded", ...status })
			case "timeout":
				return new SearchConsoleApiError({ message: "Search Console request timed out" })
			case "invalid_response":
				return new SearchConsoleApiError({ message: unexpected })
			case "not_found":
			case "upstream":
				return new SearchConsoleApiError({
					message:
						error.status === undefined
							? "Search Console request failed"
							: `Search Console returned ${error.status}${detail}`,
					...status,
				})
		}
	}

const searchConsoleClient = (httpClient: HttpClient.HttpClient, accessToken: string, unexpected: string) =>
	VendorHttp.make({
		httpClient,
		peerService: "google-search-console",
		baseUrl: SEARCH_CONSOLE_API_BASE_URL,
		auth: VendorHttp.bearer(accessToken),
		headers: { accept: "application/json" },
		toError: toSearchConsoleError(unexpected),
		detail: googleDetail,
		timeout: REQUEST_TIMEOUT,
	})

/** Every property the token's Google account can see, with its permission level. */
export const listSites = Effect.fn("SearchConsole.listSites")(function* (
	httpClient: HttpClient.HttpClient,
	accessToken: string,
) {
	const body = yield* searchConsoleClient(
		httpClient,
		accessToken,
		"Search Console returned an unexpected site list",
	).json(SitesListResponse, { path: "/sites", operation: "listing sites" })
	return body.siteEntry ?? []
})

/** One page of Search Analytics rows for a property. */
export const querySearchAnalytics = Effect.fn("SearchConsole.querySearchAnalytics")(function* (
	httpClient: HttpClient.HttpClient,
	accessToken: string,
	siteUrl: string,
	query: SearchAnalyticsQuery,
) {
	const body = searchAnalyticsRequestBody(query)
	yield* Effect.annotateCurrentSpan({
		"maple.search_console.start_row": body.startRow,
		"maple.search_console.dimensions": Arr.join(query.dimensions, ","),
	})
	const response = yield* searchConsoleClient(
		httpClient,
		accessToken,
		"Search Console returned an unexpected Search Analytics payload",
	).json(SearchAnalyticsResponse, {
		method: "POST",
		path: searchAnalyticsPath(siteUrl),
		body,
		operation: "querying Search Analytics",
		// Not retried here: the import's own day-by-day backoff decides when a failed day runs again.
	})
	const rows = response.rows ?? []
	yield* Effect.annotateCurrentSpan("maple.search_console.rows", rows.length)
	return {
		rows,
		// A short page is the last one; a full page may have more behind it.
		nextStartRow: rows.length < body.rowLimit ? null : body.startRow + rows.length,
	} satisfies SearchAnalyticsPage
})
