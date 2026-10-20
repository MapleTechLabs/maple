import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import * as Tooltip from "@maple/web/ui/tooltip"
import { Option, Schema } from "effect"
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
const TOOLTIP_ID = "log-detail-tooltip"

/** The copy buttons the sheet's one Tooltip serves. */
export const JSON_COPY_TRIGGER = "log-detail-copy-json"
export const PROMPT_COPY_TRIGGER = "log-detail-copy-prompt"

/** The sheet: the log, its dialog, the body and error expansions, tabs, attributes, copies, tooltip. */
export const Model = Schema.Struct({
	log: LocalLog,
	dialog: Dialog.Model,
	isBodyExpanded: Schema.Boolean,
	isErrorExpanded: Schema.Boolean,
	tabs: Tabs.Model,
	attributes: AttributesPanel.Model,
	copies: Copies,
	tooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

/** The sheet's tabs: Trace only when the log carries a trace id. */
export const tabValuesOf = (log: LocalLog): ReadonlyArray<string> =>
	log.traceId ? ["attributes", "trace", "raw"] : ["attributes", "raw"]

/** The sheet with `log` in it, closed: `update.openLog` opens it. */
export const withLog = (maybeSheet: Option.Option<Model>, log: LocalLog): Model =>
	Option.match(maybeSheet, {
		onNone: () => ({
			log,
			dialog: Dialog.init(SHEET_ID, "sheet"),
			isBodyExpanded: false,
			isErrorExpanded: false,
			tabs: Tabs.init({ idBase: 900, values: tabValuesOf(log), selected: "attributes" }),
			attributes: AttributesPanel.init("log-detail-attributes"),
			copies: {},
			tooltip: Tooltip.init(TOOLTIP_ID),
		}),
		// A sheet that stays mounted keeps its tab and body expansion; the rest is per log. The tooltip
		// starts closed: one left open when the sheet closed would show on a button nobody hovered.
		onSome: (sheet) => {
			const isSameLog = logKey(sheet.log) === logKey(log)
			return {
				...sheet,
				log,
				isErrorExpanded: isSameLog && sheet.isErrorExpanded,
				tabs: { ...sheet.tabs, values: tabValuesOf(log) },
				attributes: isSameLog ? sheet.attributes : AttributesPanel.init("log-detail-attributes"),
				tooltip: Tooltip.init(TOOLTIP_ID),
			}
		},
	})
