import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { SpanNodeData } from "../trace-data"

// The Waterfall tab (`SpanHierarchy`, packages/ui/src/components/traces/span-hierarchy.tsx).

/** One rendered row of the virtual window, by its index into the visible rows. */
export const VirtualRow = Schema.Struct({ index: Schema.Number, start: Schema.Number })
export type VirtualRow = typeof VirtualRow.Type

export const Model = Schema.Struct({
	rootSpans: Schema.Array(SpanNodeData),
	totalDurationMs: Schema.Number,
	traceStartTime: Schema.String,
	totalSpanCount: Schema.Number,
	/** Span ids whose children show (`expandedSpans`). */
	expanded: Schema.Array(Schema.String),
	selectedSpanId: Schema.NullOr(Schema.String),
	virtualRows: Schema.Array(VirtualRow),
	totalSize: Schema.Number,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedToggle: { spanId: Schema.String },
	ClickedRow: { spanId: Schema.String },
	ClickedCollapseOneLevel: {},
	ClickedExpandOneLevel: {},
	ClickedCollapseAll: {},
	ClickedExpandAll: {},
	ChangedVirtualWindow: { rows: Schema.Array(VirtualRow), totalSize: Schema.Number },
	/** The page's selection changed after mount (the `informSelectedSpan` operation). */
	InformedOfSelectedSpan: { spanId: Schema.NullOr(Schema.String) },
})
export type Message = typeof Message.Type

/** What the page reacts to: a row was picked (the page owns the selection). */
export const OutMessage = defineMessageUnion({
	SelectedSpan: { spanId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
