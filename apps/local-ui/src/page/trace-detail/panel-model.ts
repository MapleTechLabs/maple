import { SpanNodeData } from "@maple/web/page/traces/detail/trace-data"
import { CopyState } from "@maple/web/page/traces/detail/span-panel/model"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import * as LogSheet from "../kit/log-sheet/model"

// The span detail panel as Model data: the selected span, its lazily
// loaded attribute maps and logs and the copy and disclosure state. Its tabs, attributes panel
// and log sheet are child Blocks on the page Model (`panelTabs`, `panelAttributes`, `panelLogSheet`).

/** The span's full attribute maps; null when the point lookup found no row. */
export const SpanAttrs = Schema.NullOr(
	Schema.Struct({
		spanAttributes: Schema.Record(Schema.String, Schema.String),
		resourceAttributes: Schema.Record(Schema.String, Schema.String),
	}),
)
export type SpanAttrs = typeof SpanAttrs.Type

/** A Logs-tab row: the whole `LocalLog` (the sheet opens on it) plus its `logKey`. */
export const SpanLog = Schema.Struct({ ...LogSheet.LocalLog.fields, key: Schema.String })
export type SpanLog = typeof SpanLog.Type

/** Matches the span logs query limit; a full page means "at least". */
export const LOG_LIMIT = 100

export const PanelModel = Schema.Struct({
	span: SpanNodeData,
	detail: SlotSchema(SpanAttrs),
	logs: SlotSchema(Schema.Array(SpanLog)),
	/** Copy status by target id (`span-name`, `duration`, `span-id`, ...). */
	copies: Schema.Record(Schema.String, CopyState),
	isErrorExpanded: Schema.Boolean,
})
export type PanelModel = typeof PanelModel.Type

export const PANEL_TABS = ["details", "logs"] as const

/** The DOM id prefix of the panel's attributes panel. */
export const PANEL_ATTRIBUTES_ID = "span-attributes"
