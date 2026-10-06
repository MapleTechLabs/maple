/**
 * The GA4 report registry. One entry per Data API `runReport` call the collector makes per
 * property per tick; one generic poll pipeline drives them all.
 *
 * Metric naming follows the Cloudflare collector's convention, and the `.by_*` suffix on
 * breakdowns is load-bearing rather than cosmetic. `channels`, `geo` and `device` each report the
 * SAME underlying total sliced a different way, so if they all wrote `google_analytics.sessions`
 * a chart with no group-by would silently show four times the real session count. The suffix
 * keeps each slice its own metric, exactly as `cloudflare.http.requests.by_country` does.
 *
 * Every value is emitted as a DELTA-temporality sum against the reconciliation ledger — see
 * `reconcile.ts` for why, and chart them with `sum`, never `rate`/`increase`.
 */

/** Instrumentation scope for every row this collector writes. */
export const SCOPE_NAME = "@maple/google-analytics"

/** Shared metric-name prefix. Dashboard-template readiness gates on exactly this string. */
export const METRIC_PREFIX = "google_analytics."

export interface GaMetricDef {
	/** The Data API metric name, sent verbatim in the request. */
	readonly ga: string
	/** The Maple metric name written to `metrics_sum`. */
	readonly metric: string
	readonly unit: string
	readonly description: string
}

export interface GaBreakdown {
	/** The Data API dimension name, sent alongside `dateHour`. */
	readonly dimension: string
	/** Attribute key on the emitted metric row. */
	readonly attributeKey: string
	/**
	 * Cardinality cap. `Attributes` sits in the metrics tables' sorting key, so an unbounded
	 * dimension degrades every read of the metric, not just this breakdown. The tail folds into
	 * one `other` series so the parts still sum to the unbroken total.
	 */
	readonly maxValues: number
	/** Metric the tail-fold ranks by — the "heaviest" values are the ones worth keeping. */
	readonly rankBy: string
	/** Truncation for a single pathological value (a 4KB URL). */
	readonly maxValueLength?: number
}

export interface GaDatasetDef {
	readonly id: string
	/** Null for the unbroken totals dataset. */
	readonly breakdown: GaBreakdown | null
	readonly metrics: ReadonlyArray<GaMetricDef>
}

const SESSIONS: GaMetricDef = {
	ga: "sessions",
	metric: "google_analytics.sessions",
	unit: "{sessions}",
	description: "Sessions",
}

/**
 * Unbroken totals. The headline numbers, and the only dataset whose metrics carry no breakdown
 * attribute — which is what makes them safe to chart without a group-by.
 */
const trafficDataset: GaDatasetDef = {
	id: "traffic",
	breakdown: null,
	metrics: [
		SESSIONS,
		{
			ga: "activeUsers",
			metric: "google_analytics.active_users",
			unit: "{users}",
			description: "Active users",
		},
		{
			ga: "newUsers",
			metric: "google_analytics.new_users",
			unit: "{users}",
			description: "First-time users",
		},
		{
			ga: "screenPageViews",
			metric: "google_analytics.page_views",
			unit: "{page_views}",
			description: "Page and screen views",
		},
		{
			ga: "engagedSessions",
			metric: "google_analytics.engaged_sessions",
			unit: "{sessions}",
			description: "Sessions that lasted over 10s, had a key event, or had 2+ page views",
		},
		{
			ga: "userEngagementDuration",
			metric: "google_analytics.engagement_duration",
			unit: "s",
			description: "Total time the site was in the foreground",
		},
	],
}

/** Where traffic came from — GA4's own channel grouping, not a re-derivation of source/medium. */
const channelsDataset: GaDatasetDef = {
	id: "channels",
	breakdown: {
		dimension: "sessionDefaultChannelGroup",
		attributeKey: "google_analytics.channel_group",
		// GA4's default channel grouping is a closed set of ~17 values; the cap is a safety net.
		maxValues: 30,
		rankBy: "sessions",
	},
	metrics: [
		{ ...SESSIONS, metric: "google_analytics.sessions.by_channel" },
		{
			ga: "activeUsers",
			metric: "google_analytics.active_users.by_channel",
			unit: "{users}",
			description: "Active users by acquisition channel",
		},
	],
}

const geoDataset: GaDatasetDef = {
	id: "geo",
	breakdown: {
		// `countryId`, not `country`: the former is ISO 3166-1 alpha-2, which matches the
		// `geo.country_iso_code` semconv key and the Cloudflare collector's spelling. `country`
		// returns localized display names, which would split "United States" per viewer locale.
		dimension: "countryId",
		attributeKey: "geo.country_iso_code",
		maxValues: 50,
		rankBy: "sessions",
	},
	metrics: [{ ...SESSIONS, metric: "google_analytics.sessions.by_country" }],
}

const deviceDataset: GaDatasetDef = {
	id: "device",
	breakdown: {
		dimension: "deviceCategory",
		attributeKey: "google_analytics.device_category",
		// desktop / mobile / tablet / smart tv — bounded by GA4 itself.
		maxValues: 10,
		rankBy: "sessions",
	},
	metrics: [{ ...SESSIONS, metric: "google_analytics.sessions.by_device" }],
}

const pagesDataset: GaDatasetDef = {
	id: "pages",
	breakdown: {
		dimension: "pagePath",
		attributeKey: "url.path",
		// The highest-cardinality dimension here by a wide margin, and the most valuable — hence a
		// higher cap than the others rather than the same one.
		maxValues: 100,
		rankBy: "screenPageViews",
		maxValueLength: 200,
	},
	metrics: [
		{
			ga: "screenPageViews",
			metric: "google_analytics.page_views.by_page",
			unit: "{page_views}",
			description: "Page views by path",
		},
		{
			ga: "activeUsers",
			metric: "google_analytics.active_users.by_page",
			unit: "{users}",
			description: "Active users by path",
		},
	],
}

const eventsDataset: GaDatasetDef = {
	id: "events",
	breakdown: {
		dimension: "eventName",
		attributeKey: "google_analytics.event_name",
		maxValues: 100,
		rankBy: "eventCount",
		maxValueLength: 100,
	},
	metrics: [
		{
			ga: "eventCount",
			metric: "google_analytics.event_count.by_event",
			unit: "{events}",
			description: "Events by name",
		},
		{
			ga: "keyEvents",
			metric: "google_analytics.key_events.by_event",
			unit: "{events}",
			description: "Key events (conversions) by name",
		},
	],
}

export const DATASETS: ReadonlyArray<GaDatasetDef> = [
	trafficDataset,
	channelsDataset,
	geoDataset,
	deviceDataset,
	pagesDataset,
	eventsDataset,
]

export const DATASET_BY_ID: ReadonlyMap<string, GaDatasetDef> = new Map(
	DATASETS.map((dataset) => [dataset.id, dataset]),
)

/**
 * Reserved state rows, which are not datasets and must never be polled as one.
 * The discovery anchor holds grant-wide `discoveredAt`; see the schema's DISCOVERY ANCHOR note.
 */
export const DISCOVERY_DATASET = "__discovery__"
export const DISCOVERY_PROPERTY_ID = ""

/** Service name for a property's rows — mirrors Cloudflare's `cloudflare/{zoneName}`. */
export const serviceNameFor = (propertyId: string): string => `google-analytics/${propertyId}`
