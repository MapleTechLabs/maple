import { V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { InvestigationSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import { Model as ConversationModel } from "../conversation/model"
import * as Canvas from "../../../service-map/xyflow/canvas"

// `/investigations/$id`.

/** `useInvestigation`: the scoped shape's state, rebuilt into the `V2Investigation` the page renders. */
export const Sync = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Missing", {}),
	Schema.TaggedStruct("Failed", {}),
	Schema.TaggedStruct("Ready", { investigation: V2Investigation }),
])
export type Sync = typeof Sync.Type

/** `SignalsCard`'s two reads: log volume by severity, and the service's overview row. */
export const LogBucket = Schema.Struct({
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Number),
})
export const TracesRow = Schema.Struct({
	spanCount: Schema.Number,
	p95LatencyMs: Schema.Number,
	errorRate: Schema.Number,
})
/** One `getServiceOverview` row; the card picks its service's busiest at render. */
export const OverviewRow = Schema.Struct({ ...TracesRow.fields, serviceName: Schema.String })
export type OverviewRow = typeof OverviewRow.Type

/** `listIssueEscalations`, reduced to the attempt for this run. */
export const Escalation = Schema.Struct({
	status: Schema.Literals(["queued", "sent", "skipped", "failed"]),
	destinations: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
})

export const Busy = Schema.NullOr(Schema.Literals(["resolve", "restart"]))

export const Model = Schema.Struct({
	id: Schema.String,
	search: InvestigationSearch,
	nowMs: Schema.Number,
	sync: Sync,
	/** Bumped by Retry: a new subscription dependency, so the live query reads a fresh collection. */
	syncAttempt: Schema.Number,
	logs: KeyedSchema(Schema.Array(LogBucket), LoadFailure),
	traces: KeyedSchema(Schema.Array(OverviewRow), LoadFailure),
	escalation: KeyedSchema(Schema.NullOr(Escalation), LoadFailure),
	busy: Busy,
	actionsMenu: Menu.Model,
	actionSheet: Dialog.Model,
	canvas: Canvas.Model,
	/** The trace chips' full-id tooltip, one Model for every chip. */
	traceTooltip: Tooltip.Model,
	/** The Chat and Transcript tabs' thread (`ChatConversation`, investigation mode), once one opened. */
	conversation: Schema.NullOr(ConversationModel),
	/** The thread's report card: the action its rows opened, from local state, in its own sheet. */
	reportActionIndex: Schema.NullOr(Schema.Number),
	reportSheet: Dialog.Model,
	/** `KnownServicesProvider`: table cells that name a service link to it; `null` until asked for. */
	knownServices: Schema.NullOr(Schema.Array(Schema.String)),
})
export type Model = typeof Model.Type
