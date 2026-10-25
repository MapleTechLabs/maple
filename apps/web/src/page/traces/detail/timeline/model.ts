import * as Select from "../../../../ui/select"
import { Schema } from "effect"
import { SpanEvents, SpanNodeData } from "../trace-data"

// The Timeline tab (packages/ui/src/components/traces/trace-timeline.tsx). The viewport lives in
// the Model and reaches the DOM as the rows container's `--vp0`/`--vpk`.

export const Viewport = Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })
export type Viewport = typeof Viewport.Type

export const SkewSummary = Schema.Struct({ adjustedCount: Schema.Number, maxSkewMs: Schema.Number })

export const Model = Schema.Struct({
	rootSpans: Schema.Array(SpanNodeData),
	totalDurationMs: Schema.Number,
	traceStartTime: Schema.String,
	/** `[...new Set(spans.map(serviceName))]`, in span order. */
	services: Schema.Array(Schema.String),
	totalSpanCount: Schema.Number,
	skew: Schema.NullOr(SkewSummary),
	traceStartMs: Schema.Number,
	traceEndMs: Schema.Number,
	viewport: Viewport,
	/** `TimelineState`: expanded parents, keyboard focus, search. */
	expandedSpanIds: Schema.Array(Schema.String),
	focusedIndex: Schema.NullOr(Schema.Number),
	searchQuery: Schema.String,
	/** 1-based current search match; 0 = none active. */
	matchCursor: Schema.Number,
	selectedSpanId: Schema.NullOr(Schema.String),
	/** A `colorByFieldId` (`preset:service`). */
	colorBy: Schema.String,
	/** `ColorByPicker`'s Select, its value kept on `colorBy`. */
	colorBySelect: Select.Model,
	spanEvents: Schema.NullOr(SpanEvents),
	/** The stored label-column width (`traceTimelineSidebarWidth`). */
	sidebarWidth: Schema.Number,
	/** The body scroller's content box and scroll offset, as the measuring Mount reports them. */
	scrollerWidth: Schema.Number,
	scrollerHeight: Schema.Number,
	scrollTop: Schema.Number,
	hoveredSpanId: Schema.NullOr(Schema.String),
	isShowingShortcuts: Schema.Boolean,
})
export type Model = typeof Model.Type
