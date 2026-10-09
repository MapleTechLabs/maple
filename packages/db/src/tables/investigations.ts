import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AiTriageIncidentKind,
	AiTriageResult,
	InvestigationConfidence,
	InvestigationProgress,
	InvestigationSeededBy,
	InvestigationStatus,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	IssueSeverity,
} from "@maple/domain/http"
import { ErrorIssueId, InvestigationId, OrgId, UserId } from "@maple/domain/primitives"

/**
 * A durable investigation "war-room". One row per investigation; it both backs
 * the `/investigations` surface AND keys the `maple-chat` durable session
 * (`<orgId>:inv-<id>`) whose first turn is the autonomous diagnostic pass.
 *
 * A typed-incident investigation mirrors its incident into the nullable
 * `incidentKind`/`incidentId` columns to keep the
 * one-investigation-per-incident dedup (the partial unique index below); a
 * free-form investigation leaves them null and is unconstrained. `reportJson`
 * holds the structured `AiTriageResult` written by `submit_diagnosis`.
 */
export const Investigations = PG.table("investigations", {
	columns: {
		id: PG.brand(PG.text, InvestigationId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		status: PG.column(PG.brand(PG.text, InvestigationStatus), { default: "investigating" }),
		seededBy: PG.column(PG.brand(PG.text, InvestigationSeededBy), { name: "seeded_by", default: "user" }),
		/** Full discriminated subject (incident ref or free-form question + context). */
		subjectJson: PG.column(PG.jsonb(InvestigationSubject), { name: "subject_json" }),
		/** Display-ready context preserved independently of the source incident. */
		snapshotJson: PG.column(PG.nullable(PG.jsonb(InvestigationSubjectSnapshot)), { name: "snapshot_json" }),
		/** Mirrored out of the subject ONLY to back the incident-dedup partial index. */
		incidentKind: PG.column(PG.nullable(PG.brand(PG.text, AiTriageIncidentKind)), { name: "incident_kind" }),
		incidentId: PG.column(PG.nullable(PG.text), { name: "incident_id" }),
		issueId: PG.column(PG.nullable(PG.brand(PG.text, ErrorIssueId)), { name: "issue_id" }),
		/** Structured diagnosis; null until the first `submit_diagnosis` lands. */
		reportJson: PG.column(PG.nullable(PG.jsonb(AiTriageResult)), { name: "report_json" }),
		/**
		 * The running pass's step tail; null until the first step, kept after the run ends. Written on
		 * a heartbeat: REPLICA IDENTITY FULL ships the whole row, jsonb blobs included, per update.
		 */
		progressJson: PG.column(PG.nullable(PG.jsonb(InvestigationProgress)), { name: "progress_json" }),
		/** Denormalized from the report for cheap war-room list rendering. */
		severity: PG.nullable(PG.brand(PG.text, IssueSeverity)),
		confidence: PG.nullable(PG.brand(PG.text, InvestigationConfidence)),
		model: PG.nullable(PG.text),
		inputTokens: PG.column(PG.nullable(PG.int4), { name: "input_tokens" }),
		outputTokens: PG.column(PG.nullable(PG.int4), { name: "output_tokens" }),
		error: PG.nullable(PG.text),
		startedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "started_at" }),
		autonomousTurns: PG.column(PG.int4, { name: "autonomous_turns", default: 0 }),
		createdBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		diagnosedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "diagnosed_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One investigation per incident. Partial so free-form investigations
		// (incident_id null) are not collapsed together.
		PG.uniqueIndex("investigations_incident_idx", ["orgId", "incidentKind", "incidentId"], {
			where: `"incident_id" is not null`,
		}),
		PG.index("investigations_org_created_idx", ["orgId", "createdAt"]),
		PG.index("investigations_org_issue_idx", ["orgId", "issueId"]),
		PG.index("investigations_org_status_idx", ["orgId", "status"]),
	],
	tenantColumn: "orgId",
})

export type InvestigationRow = PG.SelectRowOf<typeof Investigations>
export type InvestigationInsert = PG.InsertRowOf<typeof Investigations>
