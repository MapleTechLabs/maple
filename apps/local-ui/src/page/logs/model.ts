import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import { Density } from "@maple/views/ui/logs/viewer"
import * as Popover from "@maple/views/ui/popover"
import * as Tooltip from "@maple/views/ui/tooltip"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import * as LogSheet from "../kit/log-sheet/model"
import { LocalLog } from "../kit/log-sheet/model"

// apps/local-ui/src/lib/log-shape.ts and the logs hooks, as Schemas.

export { LocalLog } from "../kit/log-sheet/model"

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

export const Draft = Schema.Struct({ text: Schema.String, version: Schema.Number, sent: Schema.String })
export type Draft = typeof Draft.Type

export const Model = Schema.TaggedStruct("LogsPage", {
	/** `useTimeWindow`'s anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	nowMs: Schema.Number,
	logs: SlotSchema(LogPages),
	isFetchingNextPage: Schema.Boolean,
	/** Bumped when the list is refetched or rekeyed; a next page from an older generation is dropped. */
	pageGeneration: Schema.Number,
	/** `dataUpdatedAt` of the active mode's main query, for the "New data" pill. */
	logsUpdatedAtMs: Schema.Number,
	patternsUpdatedAtMs: Schema.Number,
	patterns: SlotSchema(LogPatterns),
	services: SlotSchema(Schema.Array(FacetOption)),
	severities: SlotSchema(Schema.Array(FacetOption)),
	/** The shared logs stream: rows derived from `logs` and the pinned columns. */
	stream: LogsStream.Model,
	/** The pinned columns the stream's rows were derived with. */
	columns: Schema.Array(Schema.String),
	/** The attribute keys of the loaded logs, offered as columns. */
	columnOptions: Schema.Array(FacetOption),
	wrap: Schema.Boolean,
	density: Density,
	toolbarTooltip: Tooltip.Model,
	columnsPopover: Popover.Model,
	search: Draft,
	modeToggle: ToggleGroup.Model,
	sections: FilterSections.Model,
	/** The log sheet, once a row was opened; it stays (closed) so the row stays selected. */
	maybeDetail: Schema.Option(LogSheet.Model),
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
