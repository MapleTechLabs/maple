import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import * as Tooltip from "@maple/web/ui/tooltip"
import * as ToggleGroup from "@maple/web/ui/toggle-group"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import * as LogSheet from "../kit/log-sheet/model"
import { LocalLog } from "../kit/log-sheet/model"

// apps/local-ui/src/lib/log-shape.ts and the logs hooks, as Schemas.

export { LocalLog } from "../kit/log-sheet/model"

export const LogPages = Schema.Struct({
	pages: Schema.Array(Schema.Array(LocalLog)),
	hasNextPage: Schema.Boolean,
})
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

/** A row's chip: the row's place in the list, its log and the attribute key. */
export const ChipRef = Schema.Struct({ index: Schema.Number, logKey: Schema.String, key: Schema.String })
export type ChipRef = typeof ChipRef.Type

/** `LogAttributeChip`'s hover card: the one shown and the rest-to-reveal / grace timers. */
export const ChipCard = Schema.Struct({
	visible: Schema.Option(ChipRef),
	pendingOpen: Schema.Option(Schema.Struct({ chip: ChipRef, generation: Schema.Number })),
	pendingClose: Schema.Option(Schema.Number),
	generation: Schema.Number,
	/** `CollapsibleJsonValue` in the shown card; a card that opens again starts collapsed. */
	isJsonExpanded: Schema.Boolean,
})
export type ChipCard = typeof ChipCard.Type

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
	viewport: Viewport,
	search: Draft,
	modeToggle: ToggleGroup.Model,
	sections: FilterSections.Model,
	/** The log sheet, once a row was opened; it stays (closed) so the row stays selected. */
	maybeDetail: Schema.Option(LogSheet.Model),
	isRefreshing: Schema.Boolean,
	copies: Copies,
	chipCard: ChipCard,
	/** The tooltip on the card JSON block copy button (`<CopyButton tooltip>`). */
	chipJsonTooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

export const CHIP_JSON_TOOLTIP_ID = "local-chip-json-copy"
export const CHIP_JSON_COPY_ID = "chip-json"
export const initChipJsonTooltip = (): Tooltip.Model => Tooltip.init(CHIP_JSON_TOOLTIP_ID)
