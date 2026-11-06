import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertEscalationRunStatus, AlertSeverity, EscalationSteps } from "@maple/domain/http"
import { AlertEscalationRunId, AlertIncidentId, EscalationChainId, OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { AlertIncidents } from "./alerts"

/**
 * Ordered notification steps a severity tier can start: notify, wait for an ack, then the next
 * step, the whole chain repeating `repeat_count` more times. Distinct from `issue_escalation_policies`,
 * which routes a triage severity once and has no timer.
 */
export const EscalationChains = PG.table("escalation_chains", {
	columns: {
		id: PG.brand(PG.text, EscalationChainId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		stepsJson: PG.column(PG.jsonb(EscalationSteps), { name: "steps_json" }),
		repeatCount: PG.column(PG.int4, { name: "repeat_count", default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("escalation_chains_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

const alertEscalationRunsColumns = {
	id: PG.brand(PG.text, AlertEscalationRunId),
	orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
	incidentId: PG.column(PG.brand(PG.text, AlertIncidentId), { name: "incident_id" }),
	/** No foreign key: a deleted chain's running escalations finish from their snapshot. */
	chainId: PG.column(PG.brand(PG.text, EscalationChainId), { name: "chain_id" }),
	chainName: PG.column(PG.text, { name: "chain_name" }),
	/** The tier whose chain this is. */
	severity: PG.brand(PG.text, AlertSeverity),
	/** The chain as it stood when the run started, so an edit cannot shift a page in flight. */
	stepsJson: PG.column(PG.jsonb(EscalationSteps), { name: "steps_json" }),
	repeatCount: PG.column(PG.int4, { name: "repeat_count" }),
	/** The next step to send and the pass it belongs to, both from 0. */
	stepIndex: PG.column(PG.int4, { name: "step_index", default: 0 }),
	passIndex: PG.column(PG.int4, { name: "pass_index", default: 0 }),
	nextStepAt: PG.column(PG.timestamptzMillis, { name: "next_step_at" }),
	status: PG.brand(PG.text, AlertEscalationRunStatus),
	/** The trigger notification the run opened with; every step resends it. */
	payloadJson: PG.column(PG.jsonb(Schema.Record(Schema.String, Schema.Unknown)), { name: "payload_json" }),
	stepsSent: PG.column(PG.int4, { name: "steps_sent", default: 0 }),
	lastStepAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_step_at" }),
	endedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "ended_at" }),
	createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
}
type AlertEscalationRunsColumns = PG.ColumnsOf<typeof alertEscalationRunsColumns>

/** One incident's walk through a chain. The scheduler advances it one step at a time. */
export const AlertEscalationRuns = PG.table("alert_escalation_runs", {
	columns: alertEscalationRunsColumns,
	primaryKey: ["id"],
	indexes: [
		PG.index("alert_escalation_runs_org_incident_idx", ["orgId", "incidentId"]),
		// The scheduler's scan: live runs only, which are a small slice of the table.
		PG.index("alert_escalation_runs_live_idx", ["status", "nextStepAt"], {
			where: `"status" in ('active', 'acknowledged')`,
		}),
		// At most one live run per incident: a newer tier's chain supersedes the old one.
		PG.uniqueIndex<AlertEscalationRunsColumns>(
			"alert_escalation_runs_live_incident_idx",
			["incidentId"],
			{
				where: ($) => $.status.in_("active", "acknowledged"),
			},
		),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["incidentId"],
			references: AlertIncidents,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type EscalationChainRow = PG.SelectRowOf<typeof EscalationChains>
export type AlertEscalationRunRow = PG.SelectRowOf<typeof AlertEscalationRuns>
