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
import { ParsedMarkdown } from "../../kit/markdown"
import { SeverityBucket } from "../kit/findings"

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

/** The events panel's chip: every event, only what went wrong, or only what concerns leads. */
export const EventFilter = Schema.Literals(["all", "problems", "leads"])

const ReportDoc = Schema.Literals(["report", "findingsDetail", "needsValidation"])

export const Model = Schema.Struct({
	runId: SecurityAuditRunId,
	nowMs: Schema.Finite,
	isAdmin: Schema.Boolean,
	run: KeyedSchema(SecurityAuditRunDetail, LoadFailure),
	/** The newest page, re-read while the run is live. */
	events: KeyedSchema(SecurityAuditEventsResponse, LoadFailure),
	/** Every event read so far, newest first and once each: polled pages and older pages merge in. */
	eventLog: Schema.Array(SecurityAuditEvent),
	isLoadingOlder: Schema.Boolean,
	/**
	 * A polled page that did not reach the events already held leaves a gap: older pages are read
	 * from its end until they meet this, the newest event held before it.
	 */
	gapUntil: Schema.NullOr(SecurityAuditEvent),
	/** Gaps found while an older page was in flight, each read once that one settles. */
	queuedGaps: Schema.Array(Schema.Struct({ cursor: SecurityAuditEvent, until: SecurityAuditEvent })),
	/** The event the older page in flight was asked to start before. */
	olderCursor: Schema.NullOr(SecurityAuditEvent),
	/** The last older page came back short: nothing is left before it. */
	hasMoreOlder: Schema.Boolean,
	units: KeyedSchema(SecurityAuditUnitsResponse, LoadFailure),
	targets: KeyedSchema(SecurityAuditTargetsResponse, LoadFailure),
	/** What this run reported, each with the finding's current triage. */
	findings: KeyedSchema(SecurityAuditFindingsResponse, LoadFailure),
	/** The severity tile narrowing the list; null shows every section. */
	severity: Schema.NullOr(SeverityBucket),
	collapsed: Schema.Array(SeverityBucket),
	/** The finding open in the side sheet. */
	openFingerprint: Schema.NullOr(Schema.String),
	findingDialog: Dialog.Model,
	/** Phases, totals, ledger and events: open while live, folded once the run finished. */
	isDetailsOpen: Schema.NullOr(Schema.Boolean),
	unitFilter: UnitFilter,
	eventFilter: EventFilter,
	isLedgerOpen: Schema.Boolean,
	busy: Schema.NullOr(Schema.Literals(["start", "cancel"])),
	cancelDialog: Dialog.Model,
	reportDialog: Dialog.Model,
	report: ReportDoc,
	/** Each report parsed once, as the chat parses replies: rejected markup renders as text. */
	parsedReports: Schema.Array(ParsedMarkdown),
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
	PickedSeverity: { bucket: Schema.NullOr(SeverityBucket) },
	ToggledSection: { bucket: SeverityBucket },
	ClickedFinding: { fingerprint: Schema.String },
	GotFindingDialogMessage: { message: Dialog.Message },
	ToggledDetails: {},
	PickedUnitFilter: { filter: UnitFilter },
	PickedEventFilter: { filter: EventFilter },
	ToggledLedger: {},
	ClickedStartRun: {},
	CompletedStartRun: { result: Schema.Result(SecurityAuditRun, LoadFailure) },
	ClickedCancel: {},
	ClickedConfirmCancel: {},
	CompletedCancel: { result: Schema.Result(SecurityAuditRun, LoadFailure) },
	GotCancelDialogMessage: { message: Dialog.Message },
	ClickedReport: { report: ReportDoc },
	CompletedParseReports: { parsed: Schema.Array(ParsedMarkdown) },
	GotReportDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type
