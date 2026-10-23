import {
	SecurityAuditEvent,
	SecurityAuditEventsResponse,
	SecurityAuditFindingsResponse,
	SecurityAuditRun,
	SecurityAuditRunDetail,
	SecurityAuditTargetsResponse,
	SecurityAuditUnitsResponse,
} from "@maple/domain/http"
import { SecurityAuditRunId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"

// `/security/runs/$runId`: one audit run, live while it is in progress.

export const UnitFilter = Schema.Literals([
	"all",
	"covered",
	"candidate",
	"in_progress",
	"planned",
	"blocked",
	"deferred",
	"not_applicable",
	"out_of_scope",
])
export type UnitFilter = typeof UnitFilter.Type

export const ReportDoc = Schema.Literals(["report", "findingsDetail", "needsValidation"])
export type ReportDoc = typeof ReportDoc.Type

export const Model = Schema.Struct({
	runId: SecurityAuditRunId,
	nowMs: Schema.Finite,
	isAdmin: Schema.Boolean,
	run: KeyedSchema(SecurityAuditRunDetail, LoadFailure),
	/** The newest page, re-read while the run is live. */
	events: KeyedSchema(SecurityAuditEventsResponse, LoadFailure),
	/** Pages before the newest one, oldest last; `Load older` appends. */
	olderEvents: Schema.Array(SecurityAuditEvent),
	isLoadingOlder: Schema.Boolean,
	/** The last older page came back short: nothing is left before it. */
	hasMoreOlder: Schema.Boolean,
	units: KeyedSchema(SecurityAuditUnitsResponse, LoadFailure),
	targets: KeyedSchema(SecurityAuditTargetsResponse, LoadFailure),
	findings: KeyedSchema(SecurityAuditFindingsResponse, LoadFailure),
	unitFilter: UnitFilter,
	isLedgerOpen: Schema.Boolean,
	busy: Schema.NullOr(Schema.Literals(["start", "cancel"])),
	cancelDialog: Dialog.Model,
	reportDialog: Dialog.Model,
	report: ReportDoc,
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
	CompletedFetchRun: result(SecurityAuditRunDetail),
	CompletedFetchEvents: result(SecurityAuditEventsResponse),
	CompletedFetchOlderEvents: { result: Schema.Result(SecurityAuditEventsResponse, LoadFailure) },
	CompletedFetchUnits: result(SecurityAuditUnitsResponse),
	CompletedFetchTargets: result(SecurityAuditTargetsResponse),
	CompletedFetchFindings: result(SecurityAuditFindingsResponse),
	TickedPoll: { nowMs: Schema.Finite },
	ClickedRetry: {},
	ClickedLoadOlder: {},
	PickedUnitFilter: { filter: UnitFilter },
	ToggledLedger: {},
	ClickedStartRun: { budget: Schema.NullOr(Schema.Finite) },
	CompletedStartRun: { result: Schema.Result(SecurityAuditRun, LoadFailure) },
	ClickedCancel: {},
	ClickedConfirmCancel: {},
	CompletedCancel: { result: Schema.Result(SecurityAuditRun, LoadFailure) },
	GotCancelDialogMessage: { message: Dialog.Message },
	ClickedReport: { report: ReportDoc },
	GotReportDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type
