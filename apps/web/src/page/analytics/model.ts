import { Schema } from "effect"
import * as Chart from "../../charts/chart"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { AnalyticsSearch } from "../../route/search"
import * as Dialog from "../../ui/dialog"
import * as FilterSections from "../../ui/filters/filter-sections"
import { SignalPresenceData } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"

// `/analytics`.

export type Search = typeof AnalyticsSearch.Type

const FacetRow = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `WebAnalyticsBreakdowns`. */
export const Breakdowns = Schema.Struct({
	referrerHosts: Schema.Array(FacetRow),
	countries: Schema.Array(FacetRow),
	deviceTypes: Schema.Array(FacetRow),
	browsers: Schema.Array(FacetRow),
	operatingSystems: Schema.Array(FacetRow),
	languages: Schema.Array(FacetRow),
	utmSources: Schema.Array(FacetRow),
	utmMediums: Schema.Array(FacetRow),
	utmCampaigns: Schema.Array(FacetRow),
	entryPaths: Schema.Array(FacetRow),
	exitPaths: Schema.Array(FacetRow),
	hosts: Schema.Array(FacetRow),
})
export type Breakdowns = typeof Breakdowns.Type

export const AnalyticsEvent = Schema.Struct({ name: Schema.String, events: Schema.Number, sessions: Schema.Number })

export const Summary = Schema.Struct({
	visitors: Schema.Number,
	sessions: Schema.Number,
	newSessions: Schema.Number,
	bouncedSessions: Schema.Number,
	identifiedSessions: Schema.Number,
	avgDurationMs: Schema.Number,
	botSessions: Schema.Number,
	botShare: Schema.NullOr(Schema.Number),
	coverage: Schema.Number,
	bounceRate: Schema.NullOr(Schema.Number),
})
export type Summary = typeof Summary.Type

export const Live = Schema.Struct({ visitors: Schema.Number, sessions: Schema.Number, windowSeconds: Schema.Number })

export const TimeseriesPoint = Schema.Struct({
	bucket: Schema.String,
	visitors: Schema.Number,
	sessions: Schema.Number,
	newSessions: Schema.Number,
	bouncedSessions: Schema.Number,
	identifiedSessions: Schema.Number,
	avgDurationMs: Schema.Number,
})

export const PageviewsPoint = Schema.Struct({ bucket: Schema.String, pageViews: Schema.Number, sessions: Schema.Number })

export const AnalyticsPage = Schema.Struct({
	host: Schema.String,
	pagePath: Schema.String,
	pageViews: Schema.Number,
	sessions: Schema.Number,
})

export const AiReferralPoint = Schema.Struct({ bucket: Schema.String, product: Schema.String, sessions: Schema.Number })

export const AiCrawlers = Schema.Struct({
	crawlers: Schema.Array(
		Schema.Struct({
			crawler: Schema.String,
			requests: Schema.Number,
			failedRequests: Schema.Number,
			pages: Schema.Number,
			lastSeen: Schema.String,
		}),
	),
	formats: Schema.Array(
		Schema.Struct({
			format: Schema.Literals(["markdown", "llms", "html", "other"]),
			requests: Schema.Number,
			failedRequests: Schema.Number,
			pages: Schema.Number,
			crawlers: Schema.Array(Schema.String),
		}),
	),
	pages: Schema.Array(
		Schema.Struct({
			host: Schema.String,
			path: Schema.String,
			requests: Schema.Number,
			crawlers: Schema.Array(Schema.String),
			lastSeen: Schema.String,
		}),
	),
})
export type AiCrawlers = typeof AiCrawlers.Type

export const TraceSample = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	timestamp: Schema.String,
	serviceName: Schema.String,
	userId: Schema.String,
	visitorId: Schema.String,
})

/** One breakdown card's own state: the picked tab (else the first populated), filter, sort. */
export const PanelState = Schema.Struct({
	pickedTab: Schema.NullOr(Schema.Number),
	query: Schema.String,
	sortKey: Schema.NullOr(Schema.Literals(["name", "count", "views"])),
	sortDir: Schema.Literals(["asc", "desc"]),
})
export type PanelState = typeof PanelState.Type


export const Model = Schema.Struct({
	search: AnalyticsSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	breakdowns: KeyedSchema(Breakdowns, LoadFailure),
	events: KeyedSchema(Schema.Array(AnalyticsEvent), LoadFailure),
	live: KeyedSchema(Live, LoadFailure),
	summary: KeyedSchema(Summary, LoadFailure),
	/** The bot split over every agent (`traffic: "all"`); the summary itself when that is the filter. */
	mix: KeyedSchema(Summary, LoadFailure),
	timeseries: KeyedSchema(Schema.Array(TimeseriesPoint), LoadFailure),
	pageviews: KeyedSchema(Schema.Array(PageviewsPoint), LoadFailure),
	pages: KeyedSchema(Schema.Array(AnalyticsPage), LoadFailure),
	previousSummary: KeyedSchema(Summary, LoadFailure),
	previousPageviews: KeyedSchema(Schema.Array(PageviewsPoint), LoadFailure),
	aiReferrals: KeyedSchema(Schema.Array(AiReferralPoint), LoadFailure),
	previousAiReferrals: KeyedSchema(Schema.Array(AiReferralPoint), LoadFailure),
	aiCrawlers: KeyedSchema(AiCrawlers, LoadFailure),
	traceSamples: KeyedSchema(Schema.Array(TraceSample), LoadFailure),
	presence: SignalPresenceData.schema,
	/** The tile picked in the strip; `null` until someone picks. */
	pickedMetric: Schema.NullOr(Schema.String),
	panels: Schema.Record(Schema.String, PanelState),
	/** An events answer that came in ahead of the breakdowns (`delivered` in update.ts). */
	heldEvents: Schema.NullOr(Schema.Struct({ key: Schema.String, result: Schema.Result(Schema.Unknown, LoadFailure) })),
	/** The breakdown card whose table is open in the dialog. */
	expandedPanel: Schema.NullOr(Schema.String),
	expandDialog: Dialog.Model,
	/** Favicon hosts whose image failed (`Favicon`'s `failed`). */
	failedFavicons: Schema.Array(Schema.String),
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
