import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as AttributesPanel from "../../../ui/attributes/attributes-panel"
import { CopyStatus } from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { LogRecord } from "../../../ui/logs/log-row-view"
import * as Tabs from "../../../ui/tabs"
import * as ToggleGroup from "../../../ui/toggle-group"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as InfraCorrelation from "../../kit/infra-correlation"

// The drawer for one log.

export const DetailCopy = Schema.Struct({ id: Schema.String, status: CopyStatus, generation: Schema.Number })

const LogRows = KeyedSchema(Schema.Array(LogRecord), LoadFailure)

/** The trace's span names by id and its start, for the timeline's dividers and offsets. */
export const TraceSpans = Schema.Struct({
	traceStartTime: Schema.NullOr(Schema.String),
	spanNames: Schema.Array(Schema.Struct({ spanId: Schema.String, spanName: Schema.String })),
})
export type TraceSpans = typeof TraceSpans.Type

export const Model = Schema.Struct({
	id: Schema.String,
	/** The org the panel reads are keyed under, given at `open`. */
	orgId: Schema.String,
	/** The org's namespace pin at `open`: `listLogsResultAtom` is `globalNamespace: "top"`. */
	pinnedNamespace: Schema.NullOr(Schema.String),
	/** `/logs/$logId`: every panel shows at once, so the trace and context read without a tab. */
	isPage: Schema.Boolean,
	/** `ErrorSection`'s Show more. */
	isErrorExpanded: Schema.Boolean,
	/** `LogContextPanel`'s scope toggle (instance first when the log names one). */
	contextScope: ToggleGroup.Model,
	contextBefore: LogRows,
	contextAfter: LogRows,
	/** `LogTraceTimeline`: the trace's logs and its spans. */
	traceLogs: LogRows,
	traceSpans: KeyedSchema(TraceSpans, LoadFailure),
	dialog: Dialog.Model,
	/** The log on show; kept while the sheet animates out. */
	log: Schema.NullOr(LogRecord),
	tabs: Tabs.Model,
	/** Rebuilt per log, which resets the attribute search. */
	attributes: AttributesPanel.Model,
	/** The Infrastructure tab, rebuilt per log. */
	infra: InfraCorrelation.Model,
	/** `LogHeroHeader`'s "Show full message". */
	isHeroExpanded: Schema.Boolean,
	/** The last copy from the hero or the meta strip, and its status. */
	copy: DetailCopy,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotTabsMessage: { message: Tabs.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	GotInfraMessage: { message: InfraCorrelation.Message },
	ClickedShowFullMessage: {},
	ClickedCopy: { copyId: Schema.String, text: Schema.String },
	ClickedCopyPermalink: { copyId: Schema.String, logKey: Schema.String },
	SucceededCopy: { generation: Schema.Number, copyId: Schema.String },
	FailedCopy: { generation: Schema.Number, copyId: Schema.String },
	ElapsedCopyStatus: { generation: Schema.Number },
	ToggledErrorExpanded: {},
	GotContextScopeMessage: { message: ToggleGroup.Message },
	ClickedLog: { log: LogRecord },
	PositionedLogRow: {},
	CompletedFetchContext: {
		key: Schema.String,
		side: Schema.Literals(["before", "after"]),
		result: Schema.Result(Schema.Array(LogRecord), LoadFailure),
	},
	CompletedFetchTraceLogs: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(LogRecord), LoadFailure),
	},
	CompletedFetchTraceSpans: { key: Schema.String, result: Schema.Result(TraceSpans, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChoseAttributeFilter: {
		source: AttributesPanel.AttributeSource,
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
	/** A copy finished: `useCopy` toasts every one (`label` absent: "Copied to clipboard"). */
	Copied: { label: Schema.UndefinedOr(Schema.String), isOk: Schema.Boolean },
	/** The sheet closed (Close, Escape, a press outside): the stream stops holding its tail. */
	Closed: {},
})
export type OutMessage = typeof OutMessage.Type
