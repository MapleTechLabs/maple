import { ErrorIssueId, IssueSeverity } from "@maple/domain/http"
import { V2Slo, V2SloStatus, V2UptimeMonitor } from "@maple/domain/http/v2"
import { AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import { TimeWindow } from "../../../data/time-range"

// The observer's Overview: is the product working, and what is worth knowing, read-only.

/** The synced alert incidents; `Unavailable` when the live sync failed or stalled. */
export const IncidentsData = AsyncData.Schema(
	Schema.Array(AlertIncidentRowSchema),
	Schema.Literal("Unavailable"),
)

/** How many alert rules the org has, to tell "nothing firing" from "nothing set up". */
export const RuleCountData = AsyncData.Schema(Schema.Number, Schema.Literal("Unavailable"))

/** An SLO beside its status (`listSloRows`); `status` is `null` when that read failed. */
export const SloRow = Schema.Struct({ slo: V2Slo, status: Schema.NullOr(V2SloStatus) })
export type SloRow = typeof SloRow.Type

/** One error issue with its events in the window. */
export const TopError = Schema.Struct({
	id: ErrorIssueId,
	title: Schema.String,
	serviceName: Schema.String,
	severity: Schema.NullOr(IssueSeverity),
	count: Schema.Number,
	lastSeenAt: Schema.String,
})
export type TopError = typeof TopError.Type

export const Model = Schema.Struct({
	/** The reads were started (by `init`, or by the Mount when the role arrived after it). */
	isEntered: Schema.Boolean,
	/** The clock the page was last read at; `null` until the entry Command answered. */
	nowMs: Schema.NullOr(Schema.Number),
	/** The last 24 hours the top errors are counted over. */
	window: Schema.NullOr(TimeWindow),
	incidents: IncidentsData.schema,
	ruleCount: RuleCountData.schema,
	monitors: KeyedSchema(Schema.Array(V2UptimeMonitor), LoadFailure),
	slos: KeyedSchema(Schema.Array(SloRow), LoadFailure),
	errors: KeyedSchema(Schema.Array(TopError), LoadFailure),
	/** Whether the org ever sent traces, so "no errors" is not said of an app that reports nothing. */
	presence: SignalPresenceData.schema,
	/** Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
