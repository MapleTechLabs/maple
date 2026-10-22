import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import { Message as ConversationMessage } from "../../chat/conversation/message"
import { Escalation, LogBucket, OverviewRow, Sync } from "./model"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	TickedClock: { nowMs: Schema.Number },
	/** The scoped shape's answer, for the org, investigation and retry attempt it was read for. */
	SyncedInvestigation: { orgId: Schema.String, id: Schema.String, attempt: Schema.Number, sync: Sync },
	CompletedFetchLogs: result(Schema.Array(LogBucket)),
	CompletedFetchTraces: result(Schema.Array(OverviewRow)),
	CompletedFetchEscalation: result(Schema.NullOr(Escalation)),
	ClickedPrimary: {},
	ClickedRetrySync: {},
	CompletedResolve: { result: Schema.Result(Schema.Void, LoadFailure) },
	CompletedRestart: { result: Schema.Result(Schema.Void, LoadFailure) },
	ClickedFollowUp: {},
	ClickedAction: { index: Schema.Number },
	/** A link inside a canvas node: the node's own click must not also open the action panel. */
	ClickedNodeLink: { href: Schema.String },
	ClickedPlaceGraph: {},
	GotActionsMenuMessage: { message: Menu.Message },
	GotActionSheetMessage: { message: Dialog.Message },
	GotCanvasMessage: { message: Canvas.Message },
	GotTraceTooltipMessage: { message: Tooltip.Message },
	GotConversationMessage: { message: ConversationMessage },
	ClickedReportAction: { index: Schema.Number },
	GotReportSheetMessage: { message: Dialog.Message },
	CompletedMountScroller: {},
	CompletedLoadKnownServices: { services: Schema.Array(Schema.String) },
	CheckedTipFocus: { triggerId: Schema.String, isFocusVisible: Schema.Boolean },
})
export type Message = typeof Message.Type
