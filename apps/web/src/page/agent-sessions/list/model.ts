import {
	AiSessionDetailsItem,
	AiSessionDistribution,
	AiSessionFacetItem,
	AiSessionListItem,
} from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AgentSessionsSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { SignalPresenceData } from "../../kit/signal-presence"
import { Detections } from "../kit/detected-models"
import { VirtualWindow } from "../kit/virtualize"

// `/agent-sessions`: the list, toolbar and rail.

export type SessionRow = typeof AiSessionListItem.Type

/** One `listAiSessions` page: its rows and how many sessions the server ranked for it. */
export const SessionsPage = Schema.Struct({
	data: Schema.Array(AiSessionListItem),
	ranked: Schema.Number,
})
export type SessionsPage = typeof SessionsPage.Type

export const Facets = Schema.Struct({
	vendors: Schema.Array(AiSessionFacetItem),
	services: Schema.Array(AiSessionFacetItem),
	environments: Schema.Array(AiSessionFacetItem),
	models: Schema.Array(AiSessionFacetItem),
	agents: Schema.Array(AiSessionFacetItem),
	tools: Schema.Array(AiSessionFacetItem),
})
export type Facets = typeof Facets.Type

export const Distributions = Schema.Struct({
	durationMs: AiSessionDistribution,
	cost: AiSessionDistribution,
	totalTokens: AiSessionDistribution,
	llmCalls: AiSessionDistribution,
	toolCalls: AiSessionDistribution,
})
export type Distributions = typeof Distributions.Type

/** The five range sections of the rail. */
export const RangeKey = Schema.Literals(["duration", "cost", "tokens", "llmCalls", "toolCalls"])
export type RangeKey = typeof RangeKey.Type

const Draft = Schema.Struct({ min: Schema.String, max: Schema.String })

export const Model = Schema.Struct({
	search: AgentSessionsSearch,
	/** "The last week", resolved unsnapped on entry and on Reload; filters keep it. */
	window: Schema.NullOr(TimeWindow),
	/** The tab counts' window: the Tools tab's own (snapped) resolution of the same week. */
	tabWindow: Schema.NullOr(TimeWindow),
	/** The clock at the last resolve, for the rows' relative times. */
	nowMs: Schema.Number,
	firstPage: KeyedSchema(SessionsPage, LoadFailure),
	/** Pages past the first, for the filter inputs they were fetched under (`filterKey`). */
	morePages: Schema.Struct({ filterKey: Schema.String, pages: Schema.Array(SessionsPage) }),
	isFetchingNextPage: Schema.Boolean,
	isPaginationStopped: Schema.Boolean,
	/** Details by session id, for the counted filters they were read under (`detailsKey`). */
	details: Schema.Struct({
		detailsKey: Schema.String,
		bySession: Schema.Record(Schema.String, AiSessionDetailsItem),
		requested: Schema.Array(Schema.String),
	}),
	facets: KeyedSchema(Facets, LoadFailure),
	distributions: KeyedSchema(Distributions, LoadFailure),
	tabSessions: KeyedSchema(Schema.Number, LoadFailure),
	tabTools: KeyedSchema(Schema.Number, LoadFailure),
	detections: Detections,
	hasPaintedTable: Schema.Boolean,
	/** The filter rail mounted (inline, or in its sheet below `lg`): its models are detected. */
	isFilterRailMounted: Schema.Boolean,
	presence: SignalPresenceData.schema,
	filterSections: FilterSections.Model,
	rangeDrafts: Schema.Record(Schema.String, Draft),
	rangeDraftVersion: Schema.Number,
	histogramHover: Schema.Record(Schema.String, Schema.Number),
	/** The bar a held press on a histogram went down on, by range: the drag preview's anchor. */
	histogramDrag: Schema.Record(Schema.String, Schema.Number),
	/** `ToolbarSearch`: what is typed, the debounce run that may commit it, the last value sent. */
	searchInput: Schema.String,
	searchVersion: Schema.Number,
	lastSentQuery: Schema.String,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** The rows the table's virtualizer has mounted. */
	listWindow: VirtualWindow,
})
export type Model = typeof Model.Type
