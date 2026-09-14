/**
 * The investigation detail page's synced shape, and the mapper that turns its
 * row back into the `V2Investigation` the page already renders.
 *
 * This replaced a 3s poll of `/v2/investigations/:id`. The poll capped how live
 * the provenance canvas could be — a verdict landing was up to three seconds
 * stale — and it could not carry a clock at all, so every elapsed readout had to
 * be re-derived on the client anyway.
 *
 * The mapper mirrors `toV2Investigation` + `InvestigationService`'s row mappers
 * on the server, for the same reason `rowToAlertRuleDocument` mirrors
 * `AlertsService`: the page renders one object, and two independent mappings for
 * it is how a canvas ends up disagreeing with the tab beside it. Where the server
 * fails a decode (a stored subject carrying an unusable incident id), this
 * returns null for that field rather than throwing — a shape stream that throws
 * inside a live query takes the page down, and a subject we cannot read is not
 * worth that.
 */
import { V2Investigation } from "@maple/domain/http/v2"
import {
	AlertIncidentId,
	AnomalyIncidentId,
	ErrorIncidentId,
	ErrorIssueId,
	InvestigationId,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
} from "@maple/domain/http"
import { Option, Schema } from "effect"
import { createSyncedCollection, timestamptzParser } from "./shape-fetch"

const decodeSubject = Schema.decodeUnknownOption(InvestigationSubject)
const decodeSnapshot = Schema.decodeUnknownOption(InvestigationSubjectSnapshot)
const decodeErrorIncidentId = Schema.decodeUnknownOption(ErrorIncidentId)
const decodeAnomalyIncidentId = Schema.decodeUnknownOption(AnomalyIncidentId)
const decodeAlertIncidentId = Schema.decodeUnknownOption(AlertIncidentId)
const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)
const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)

/**
 * The whole object, decoded rather than asserted.
 *
 * The alternative — build the struct and cast it to `V2Investigation` — silently
 * accepted a null `snapshot` on a schema that requires one, which would have
 * crashed the page on `snapshot.facts` for every investigation opened without a
 * stored snapshot. The decode is over the *type* side (ids are already raw here,
 * the wire's public-id encoding is the encode direction), so it costs one pass
 * and catches exactly that class of drift.
 */
const decodeInvestigation = Schema.decodeUnknownOption(Schema.toType(V2Investigation))

// Rows

/**
 * Identity row schema for the `investigation` shape — one struct per column the
 * proxy projects, so a post-deploy column drift surfaces as a SchemaValidationError
 * (→ the bounded self-heal) rather than as silently-missing fields. Timestamps stay
 * `Schema.String`: the timestamptz parser has already normalized them to ISO.
 */
export const InvestigationRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	status: Schema.String,
	seeded_by: Schema.String,
	subject_json: Schema.Unknown,
	snapshot_json: Schema.NullOr(Schema.Unknown),
	report_json: Schema.NullOr(Schema.Unknown),
	severity: Schema.NullOr(Schema.String),
	confidence: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	input_tokens: Schema.NullOr(Schema.Number),
	output_tokens: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	created_by: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	started_at: Schema.NullOr(Schema.String),
	diagnosed_at: Schema.NullOr(Schema.String),
	updated_at: Schema.String,
})
export type InvestigationRow = typeof InvestigationRowSchema.Type

// Mappers (mirror toV2Investigation + InvestigationService's row mappers)

/**
 * The stored subject, renamed to the wire's snake_case shape.
 *
 * Note the ids: the v2 subject schema *encodes* to `einc_…` public ids but its
 * decoded type is the underlying raw id, which is what the row already holds — so
 * this renames fields and re-brands, it does not encode. An incident id that
 * fails to decode drops the whole subject (the server raises
 * `InvestigationSubjectDecodeError` at the same point); the page renders its
 * freeform fallback rather than a chain built on an id nothing can open.
 */
export const rowToSubject = (row: InvestigationRow): V2Investigation["subject"] | null => {
	const decoded = decodeSubject(row.subject_json)
	if (Option.isNone(decoded)) return null
	const subject = decoded.value
	if (subject.type === "freeform") {
		return {
			type: "freeform",
			title: subject.title,
			prompt: subject.prompt,
			context_refs: subject.contextRefs,
		}
	}
	if (subject.type === "fix_verification") {
		return {
			type: "fix_verification",
			issue_id: subject.issueId,
			pull_request_url: subject.pullRequestUrl,
			baseline_versions: subject.baselineVersions,
			merged_at: subject.mergedAt,
		}
	}
	const issueId = subject.issueId == null ? null : Option.getOrNull(decodeIssueId(subject.issueId))
	switch (subject.incidentKind) {
		case "error": {
			const incidentId = decodeErrorIncidentId(subject.incidentId)
			if (Option.isNone(incidentId)) return null
			return {
				type: "incident",
				issue_id: issueId,
				incident_kind: "error",
				incident_id: incidentId.value,
			}
		}
		case "anomaly": {
			const incidentId = decodeAnomalyIncidentId(subject.incidentId)
			if (Option.isNone(incidentId)) return null
			return {
				type: "incident",
				issue_id: issueId,
				incident_kind: "anomaly",
				incident_id: incidentId.value,
			}
		}
		default: {
			const incidentId = decodeAlertIncidentId(subject.incidentId)
			if (Option.isNone(incidentId)) return null
			return {
				type: "incident",
				issue_id: issueId,
				incident_kind: "alert",
				incident_id: incidentId.value,
			}
		}
	}
}

/**
 * What the page shows when an investigation was opened without a stored
 * snapshot — mirrors `fallbackSnapshot` in InvestigationService.
 *
 * `snapshot` is non-nullable on the v2 resource and the page reads straight
 * through it (`snapshot.facts`, `snapshot.title`), so this is not a nicety: a
 * null here is a crash, and the column is nullable.
 */
const fallbackSnapshot = (subject: V2Investigation["subject"]): V2Investigation["snapshot"] => ({
	title:
		subject.type === "freeform"
			? subject.title
			: subject.type === "fix_verification"
				? "Fix verification"
				: `${subject.incident_kind[0]?.toUpperCase() ?? ""}${subject.incident_kind.slice(1)} incident`,
	scope: null,
	status: "open",
	severity: null,
	facts:
		subject.type === "incident"
			? [{ label: "Incident", value: subject.incident_id }]
			: subject.type === "fix_verification"
				? [{ label: "Pull request", value: subject.pull_request_url }]
				: [],
	references: [],
	incidentStartedAt: null,
	incidentEndedAt: null,
})

/**
 * The whole page's object, rebuilt from the row.
 *
 * `report_json` and `snapshot_json` are passed through as the stored documents:
 * the server's only work on them is decoding evidence trace ids, which is a
 * validation step, not a transform — the values the browser renders are the
 * stored ones either way.
 */
export const rowsToInvestigation = (row: InvestigationRow): V2Investigation | null => {
	const subject = rowToSubject(row)
	if (subject === null) return null
	const stored = row.snapshot_json == null ? Option.none() : decodeSnapshot(row.snapshot_json)
	const candidate = {
		id: Option.getOrNull(decodeInvestigationId(row.id)),
		object: "investigation",
		status: row.status,
		subject,
		snapshot: Option.getOrElse(stored, () => fallbackSnapshot(subject)),
		report: row.report_json,
		model: row.model,
		severity: row.severity,
		confidence: row.confidence,
		seeded_by: row.seeded_by,
		created_by: row.created_by,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		error: row.error,
		created_at: row.created_at,
		started_at: row.started_at,
		diagnosed_at: row.diagnosed_at,
		updated_at: row.updated_at,
	}
	return Option.getOrNull(decodeInvestigation(candidate))
}

// Collections (read-only — the page writes through the v2 API, not the shape)

export const createInvestigationCollection = (orgId: string, investigationId: string) =>
	createSyncedCollection({
		shape: "investigation",
		scope: investigationId,
		orgId,
		schema: InvestigationRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export type InvestigationCollection = ReturnType<typeof createInvestigationCollection>
