import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { SpanEvents } from "../trace-data"

export const Message = defineMessageUnion({
	CompletedReadSidebarWidth: { width: Schema.NullOr(Schema.Number) },
	MeasuredScroller: { width: Schema.Number, height: Schema.Number },
	ScrolledBody: { scrollTop: Schema.Number },
	CompletedScrollRequest: {},
	CompletedFocusSearch: {},
	ChangedSearch: { query: Schema.String },
	ClickedClearSearch: {},
	PressedSearchKey: { key: Schema.String, isShift: Schema.Boolean },
	PressedTimelineKey: { key: Schema.String, isShift: Schema.Boolean },
	ClickedRow: { spanId: Schema.String },
	DoubleClickedRow: { spanId: Schema.String },
	ClickedToggleCollapse: { spanId: Schema.String },
	/** ⌥-click: the whole subtree opens or closes with the span. */
	AltClickedToggleCollapse: { spanId: Schema.String },
	HoveredRow: { spanId: Schema.NullOr(Schema.String) },
	ClickedCollapseOneLevel: {},
	ClickedExpandOneLevel: {},
	ClickedCollapseAll: {},
	ClickedExpandAll: {},
	ClickedFit: {},
	ClickedShortcuts: {},
	ClickedCloseShortcuts: {},
	/** A click inside the shortcuts sheet, which must not reach the closing backdrop. */
	ClickedShortcutsSheet: {},
	/** A color-by option picked (`colorByFieldId`). */
	SelectedColorBy: { colorBy: Schema.String },
	/** The page changed the selection (`informSelectedSpanId`). */
	InformedOfSelectedSpanId: { spanId: Schema.NullOr(Schema.String) },
	/** The page loaded the trace's span events (`informSpanEvents`). */
	InformedOfSpanEvents: { spanEvents: Schema.NullOr(SpanEvents) },
	/** The page's colour-by state changed (`informColorBy`). */
	InformedOfColorBy: { colorBy: Schema.String },
})
export type Message = typeof Message.Type

/** What the page acts on: the span selection and the color scheme are TraceViewTabs state. */
export const OutMessage = defineMessageUnion({
	SelectedSpan: { spanId: Schema.String },
	ChangedColorBy: { colorBy: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
