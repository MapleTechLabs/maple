// Google Search Console API (webmasters v3) through `@distilled.cloud/gcp`: the property list and
// Search Analytics queries. Callers pass an OAuth access token; a 401 fails
// `SearchConsoleTokenRejectedError`, which the Google OAuth service's refresh-and-retry keys on.
import * as Gcp from "@distilled.cloud/gcp"
import * as SearchConsole from "@distilled.cloud/gcp/searchconsole_v1"
import { Effect, Layer, Option, Redacted, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import type * as VendorHttp from "../vendor-http"
import * as VendorSdk from "../vendor-sdk"

const SEARCH_CONSOLE_API_ORIGIN = "https://www.googleapis.com"
export const SEARCH_CONSOLE_API_BASE_URL = `${SEARCH_CONSOLE_API_ORIGIN}/webmasters/v3`
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

// Google's message from its JSON envelope. The SDK uses a non-JSON body's text as the message;
// a page of markup is not Google's words, so it is dropped.
const googleDetail = (error: VendorSdk.SdkFailure, status: number) =>
	Option.getOrUndefined(
		Option.filter(
			Option.fromNullishOr(VendorSdk.messageOf(error, status)),
			(message) => !Str.includes("<")(message),
		),
	)

const STATUS_BY_TAG = Rec.fromEntries(
	Arr.map(Rec.toEntries(Gcp.HTTP_STATUS_MAP), ([status, error]) => [error.name, Number(status)]),
)

const searchConsoleClient = (httpClient: HttpClient.HttpClient, accessToken: string, unexpected: string) =>
	VendorSdk.make({
		httpClient,
		peerService: "google-search-console",
		sdk: Layer.mergeAll(
			Gcp.fromAccessToken({ accessToken: Redacted.make(accessToken) }),
			Layer.succeed(Gcp.Retry.Retry, { while: () => false }),
			// The SDK's default host is `searchconsole.googleapis.com`; this keeps the one Maple has used.
			Gcp.Endpoint.of(SEARCH_CONSOLE_API_ORIGIN),
		),
		statusByTag: STATUS_BY_TAG,
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
	).call(SitesListResponse, SearchConsole.listSites({}), { operation: "listing sites" })
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
	).call(
		SearchAnalyticsResponse,
		// The site URL is one path segment, encoded whole by the SDK.
		SearchConsole.querySearchanalytics({ siteUrl, body: { ...body, dimensions: [...body.dimensions] } }),
		// Not retried here: the import's own day-by-day backoff decides when a failed day runs again.
		{ method: "POST", operation: "querying Search Analytics" },
	)
	const rows = response.rows ?? []
	yield* Effect.annotateCurrentSpan("maple.search_console.rows", rows.length)
	return {
		rows,
		// A short page is the last one; a full page may have more behind it.
		nextStartRow: rows.length < body.rowLimit ? null : body.startRow + rows.length,
	} satisfies SearchAnalyticsPage
})
