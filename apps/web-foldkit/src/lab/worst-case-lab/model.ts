import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Message as HubMessage } from "../../page/alerts/hub/message"
import { Model as HubModel } from "../../page/alerts/hub/model"
import { Message as SignalMessage } from "../../page/errors/hub/message"
import { HostSortKey } from "../../page/infra/hosts/list/message"
import { SortState } from "../../page/kit/table-sort"
import * as AttributesPanel from "../../ui/attributes/attributes-panel"
import * as LogsStream from "../../ui/logs/logs-stream"
import * as ReleaseOverlays from "../../page/releases/overlays"
import * as Toast from "../../ui/toast"
import * as TraceBox from "./trace-box"

// `/lab/worst-case`: product components over worst-case
// fixtures, with a demo twin of each, behind the Demo data / Worst case toggle. Shell-free.

export const WorstCaseMode = Schema.Literals(["demo", "worst"])
export type WorstCaseMode = typeof WorstCaseMode.Type

export const Flags = Schema.Struct({
	/** The boot clock, read once. */
	nowMs: Schema.Number,
	timeZone: Schema.String,
	/** The route's `?data=` search, `worst` when absent or unknown. */
	mode: WorstCaseMode,
})
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
	mode: WorstCaseMode,
	nowMs: Schema.Number,
	timeZone: Schema.String,
	/** The two `TraceBox`es, rebuilt on a mode change. */
	waterfallBox: Schema.NullOr(TraceBox.Model),
	timelineBox: Schema.NullOr(TraceBox.Model),
	/** `HostTable`'s own `useTableSort`: `cpuPct` descending until a head is clicked. */
	hostSort: SortState,
	/** `LegendSection`'s hidden series, shared by its three legends and kept across modes. */
	hiddenSeries: Schema.Array(Schema.String),
	/** The alerts hub's local UI behind `RulesTab`: the rules search, show-all and row menus. */
	hub: HubModel,
	logs: LogsStream.Model,
	attributes: AttributesPanel.Model,
	/** The open tool rows, by `tool:<toolCallId>`. */
	openTools: Schema.Array(Schema.String),
	/** The root `ToastProvider`'s two Notifications regions. */
	toasts: Toast.Model,
	/** `ReleaseComparison`'s health tooltip and commit hover card. */
	releaseOverlays: ReleaseOverlays.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedMode: { mode: WorstCaseMode },
	CompletedReplaceUrl: {},
	ClickedLoadMore: {},
	GotWaterfallBoxMessage: { message: TraceBox.Message },
	GotTimelineBoxMessage: { message: TraceBox.Message },
	ToggledLegendSeries: { key: Schema.String },
	ClickedHostSort: { key: HostSortKey },
	GotSignalRowMessage: { message: SignalMessage },
	GotRulesMessage: { message: HubMessage },
	GotLogsMessage: { message: LogsStream.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	ToggledTool: { id: Schema.String },
	GotToastMessage: { message: Toast.Message },
	GotReleaseOverlaysMessage: { message: ReleaseOverlays.Message },
})
export type Message = typeof Message.Type
