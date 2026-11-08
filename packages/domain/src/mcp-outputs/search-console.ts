/** Output schemas for the Search Console MCP tools: imported Google search performance per property. */
import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

export const SearchConsoleToolSort = Schema.Literals(["clicks", "impressions", "ctr", "position"])

export const SearchConsoleDevice = Schema.Literals(["desktop", "mobile", "tablet"])

const MetricFields = {
	clicks: Schema.Number,
	impressions: Schema.Number,
	/** clicks / impressions, 0..1; 0 with no impressions. */
	ctr: Schema.Number,
	/** Impression-weighted average position, 0 with no impressions. Lower is better. */
	position: Schema.Number,
} as const

export const SearchConsoleMetrics = Schema.Struct(MetricFields)

/** The property read, and how far its import has got. */
export const SearchConsoleSiteState = Schema.Struct({
	/** Google's property id: `sc-domain:example.com` or a URL prefix. */
	siteUrl: Schema.String,
	/** The newest fully imported day (`YYYY-MM-DD`, Google's Pacific day). */
	dataThrough: Schema.NullOr(Schema.String),
	/** The oldest imported day; history before it is still importing, unless at Google's 16-month floor. */
	historyFrom: Schema.NullOr(Schema.String),
	lastSyncedAt: Schema.NullOr(Schema.String),
	lastError: Schema.NullOr(Schema.String),
	/** Other enabled properties of the org, readable with `site`. */
	otherSites: Schema.Array(Schema.String),
})

// search_console_queries

export const SearchConsoleQueryRow = Schema.Struct({ query: Schema.String, ...MetricFields })

export const SearchConsoleQueriesOutput = Schema.Struct({
	site: SearchConsoleSiteState,
	timeRange: OutputTimeRange,
	sort: SearchConsoleToolSort,
	page: Schema.optionalKey(Schema.String),
	country: Schema.optionalKey(Schema.String),
	device: Schema.optionalKey(SearchConsoleDevice),
	/** The whole property over the window (site grain), never narrowed by the filters. */
	totals: Schema.Struct({ ...MetricFields, previous: SearchConsoleMetrics }),
	/** False while the window or its previous period starts before `site.historyFrom`: no change is shown. */
	comparable: Schema.Boolean,
	queries: Schema.Array(SearchConsoleQueryRow),
	truncated: Schema.Boolean,
})

// search_console_pages

export const SearchConsolePageRow = Schema.Struct({
	/** The most clicked URL Google reported for this host + path. */
	page: Schema.String,
	host: Schema.String,
	path: Schema.String,
	...MetricFields,
	/** Human sessions that entered on this page, from Maple's browser SDK. */
	sessions: Schema.Number,
	/** Single-page sessions over sessions reporting page views; null when none do. */
	bounceRate: Schema.NullOr(Schema.Number),
	/** Entering sessions that fired the conversion event; null when none was asked for. */
	conversions: Schema.NullOr(Schema.Number),
})

export const SearchConsolePagesOutput = Schema.Struct({
	site: SearchConsoleSiteState,
	timeRange: OutputTimeRange,
	sort: SearchConsoleToolSort,
	conversionEvent: Schema.optionalKey(Schema.String),
	/** False while the window starts before `site.historyFrom`: its numbers are partial. */
	complete: Schema.Boolean,
	pages: Schema.Array(SearchConsolePageRow),
	truncated: Schema.Boolean,
})
