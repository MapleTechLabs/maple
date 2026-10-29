import { AttributesPanelBlock } from "@maple/web/ui/attributes/attributes-panel-block"
import { DialogBlock } from "@maple/web/ui/dialog-view"
import { TabsBlock } from "@maple/web/ui/tabs-view"
import { TooltipBlock } from "@maple/web/ui/tooltip"
import { Schema } from "effect"
import { Copies } from "../copies"

// The log detail sheet as data, shared by the
// Logs page and the span panel's Logs tab.

/** `LocalLog` (lib/log-shape.ts): one log row, attribute maps already decoded. */
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

export const logKey = (log: LocalLog): string =>
	`${log.timestamp}|${log.serviceName}|${log.traceId}|${log.spanId}|${log.recordIdentity}`

export const SHEET_ID = "log-detail-sheet"
export const TOOLTIP_ID = "log-detail-tooltip"
export const ATTRIBUTES_ID = "log-detail-attributes"
export const TABS_ID_BASE = 900

/** The copy buttons the sheet's one Tooltip serves. */
export const JSON_COPY_TRIGGER = "log-detail-copy-json"
export const PROMPT_COPY_TRIGGER = "log-detail-copy-prompt"

/** The sheet: the log, its dialog, the body and error expansions, tabs, attributes, copies, tooltip. */
export const Model = Schema.Struct({
	log: LocalLog,
	dialog: DialogBlock.Model,
	isBodyExpanded: Schema.Boolean,
	isErrorExpanded: Schema.Boolean,
	tabs: TabsBlock.Model,
	attributes: AttributesPanelBlock.Model,
	copies: Copies,
	tooltip: TooltipBlock.Model,
})
export type Model = typeof Model.Type

/** The sheet's tabs: Trace only when the log carries a trace id. */
export const tabValuesOf = (log: LocalLog): ReadonlyArray<string> =>
	log.traceId ? ["attributes", "trace", "raw"] : ["attributes", "raw"]

/** What the child Bindings start from: the log the sheet opens on. */
export const ChildInitContext = Schema.Struct({ log: LocalLog })
export type ChildInitContext = typeof ChildInitContext.Type
