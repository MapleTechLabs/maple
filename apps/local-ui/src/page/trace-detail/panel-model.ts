import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web/ui/tabs"
import { SpanNodeData } from "@maple/web/page/traces/detail/trace-data"
import { CopyState } from "@maple/web/page/traces/detail/span-panel/model"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import * as LogSheet from "../kit/log-sheet/model"

// The span detail panel as Model data: the selected span, its lazily
// loaded attribute maps and logs, the Details / Logs tabs and the copy and disclosure state.

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
	tabs: Tabs.Model,
	/** Copy status by target id (`span-name`, `duration`, `span-id`, ...). */
	copies: Schema.Record(Schema.String, CopyState),
	isErrorExpanded: Schema.Boolean,
	attributes: AttributesPanel.Model,
	/** `SpanLogs`' own `LogDetailSheet`, once a log row was clicked. */
	maybeLogSheet: Schema.Option(LogSheet.Model),
})
export type PanelModel = typeof PanelModel.Type

export const PANEL_TABS = ["details", "logs"] as const
