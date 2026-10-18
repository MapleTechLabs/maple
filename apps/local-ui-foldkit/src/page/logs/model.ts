import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import * as ToggleGroup from "@maple/web-foldkit/ui/toggle-group"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"

// apps/local-ui/src/lib/log-shape.ts and the logs hooks, as Schemas.

/** `LocalLog`: one row of the list, attribute maps already decoded. */
export const LocalLog = Schema.Struct({
	/** The stored `DateTime64(9)` value with its nanoseconds: shown verbatim and the keyset cursor. */
	timestamp: Schema.String,
	severityText: Schema.String,
	severityNumber: Schema.Number,
	serviceName: Schema.String,
	body: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	recordIdentity: Schema.String,
	logAttributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
})
export type LocalLog = typeof LocalLog.Type

export const LogPages = Schema.Struct({ pages: Schema.Array(Schema.Array(LocalLog)), hasNextPage: Schema.Boolean })
export type LogPages = typeof LogPages.Type

export const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type FacetOption = typeof FacetOption.Type

/** `LogPattern` (`@maple/query-engine/observability`). */
export const LogPattern = Schema.Struct({
	template: Schema.String,
	count: Schema.Number,
	sample: Schema.String,
	severityCounts: Schema.Record(Schema.String, Schema.Number),
	serviceCounts: Schema.Record(Schema.String, Schema.Number),
})
export type LogPattern = typeof LogPattern.Type

/** `LocalLogPatterns`: the clusters, the sample size and whether the sample hit its cap. */
export const LogPatterns = Schema.Struct({
	patterns: Schema.Array(LogPattern),
	totalSampled: Schema.Number,
	isTruncated: Schema.Boolean,
})
export type LogPatterns = typeof LogPatterns.Type

/** The virtualizer's viewport: what the stream's scroller shows, read by a Mount. */
export const Viewport = Schema.Struct({ scrollTop: Schema.Number, height: Schema.Number })
export type Viewport = typeof Viewport.Type

/** The open detail sheet: the log, its body expansion, tabs and attribute panel. */
export const Detail = Schema.Struct({
	log: LocalLog,
	isOpen: Schema.Boolean,
	isBodyExpanded: Schema.Boolean,
	tabs: Tabs.Model,
	attributes: AttributesPanel.Model,
})
export type Detail = typeof Detail.Type

export const Draft = Schema.Struct({ text: Schema.String, version: Schema.Number, sent: Schema.String })
export type Draft = typeof Draft.Type

export const Model = Schema.TaggedStruct("LogsPage", {
	/** `useTimeWindow`'s anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	nowMs: Schema.Number,
	logs: SlotSchema(LogPages),
	isFetchingNextPage: Schema.Boolean,
	/** `dataUpdatedAt` of the active mode's main query, for the "New data" pill. */
	logsUpdatedAtMs: Schema.Number,
	patternsUpdatedAtMs: Schema.Number,
	patterns: SlotSchema(LogPatterns),
	services: SlotSchema(Schema.Array(FacetOption)),
	severities: SlotSchema(Schema.Array(FacetOption)),
	viewport: Viewport,
	search: Draft,
	modeToggle: ToggleGroup.Model,
	sections: FilterSections.Model,
	maybeDetail: Schema.Option(Detail),
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
