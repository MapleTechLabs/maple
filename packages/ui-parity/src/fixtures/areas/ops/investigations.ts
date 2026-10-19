import { Effect, Schema } from "effect"
import { InvestigationNotFoundError } from "@maple/domain/http"
import { V2Investigation } from "@maple/domain/http/v2"
import type { EndpointHandler, SyncedRow } from "../../dataset.ts"
import { acmeAdmin, FROZEN_NOW_MS, fixtureUuid, MINUTE } from "../../identity.ts"
import { ANOMALY_LATENCY_ID } from "./anomalies.ts"
import { iso, list, str } from "./synthetic.ts"

/**
 * Investigations are Postgres rows: the list reads `/v2/investigations`, the detail page streams
 * the `investigation_v2` shape. Both come from one type-side object per investigation, mapped
 * the way `toV2Investigation` (wire) and the row writer (camelCase jsonb) store it.
 */

/** The seeded payment-svc pool-timeout trace (also used by the routes area). */
const POOL_TIMEOUT_TRACE = "6843a8853182b32339b2dd5120d423f2"
const ALERT_INCIDENT_ID = fixtureUuid(3, 1)

export const INVESTIGATION_DIAGNOSED_ID = fixtureUuid(0x61, 1)
export const INVESTIGATION_RUNNING_ID = fixtureUuid(0x61, 2)

const at = (agoMinutes: number) => iso(FROZEN_NOW_MS - agoMinutes * MINUTE)

const steps = (startAgo: number, labels: ReadonlyArray<readonly [string, string]>) =>
	labels.map(([tool, label], index) => ({ tool, label, at: FROZEN_NOW_MS - (startAgo - index) * MINUTE }))

const diagnosed = {
	id: INVESTIGATION_DIAGNOSED_ID,
	object: "investigation" as const,
	status: "diagnosed" as const,
	subject: {
		type: "incident" as const,
		issue_id: null,
		incident_kind: "anomaly" as const,
		incident_id: ANOMALY_LATENCY_ID,
	},
	snapshot: {
		title: "payment-svc p95 latency above baseline",
		scope: "payment-svc",
		status: "open",
		severity: "critical" as const,
		facts: [
			{ label: "Signal", value: "p95 latency" },
			{ label: "Observed", value: "1,840 ms" },
			{ label: "Baseline", value: "412 ms" },
		],
		references: [],
		incidentStartedAt: at(110),
		incidentEndedAt: null,
	},
	progress: {
		stepCount: 6,
		steps: steps(104, [
			["service_overview", "Compared payment-svc against its 24h baseline"],
			["list_releases", "Found payment-svc 3.5.0 rolled out 2h ago"],
			["search_traces", "Pulled slow POST /charge traces"],
			["inspect_trace", "Read a pool-timeout trace end to end"],
			["search_logs", 'Matched "connection pool exhausted" log lines'],
			["submit_diagnosis", "Submitted the diagnosis"],
		]),
		updatedAt: FROZEN_NOW_MS - 98 * MINUTE,
	},
	report: {
		summary:
			"payment-svc 3.5.0 exhausts its Postgres connection pool under checkout load, so charges queue behind the pool and p95 latency jumped from ~410 ms to ~1.8 s.",
		suspectedCause:
			"The 3.5.0 rollout halved the payments pool size while adding a second query per charge.",
		severityAssessment: "critical" as const,
		affectedScope: "POST /charge on payment-svc and every checkout-api request that waits on it.",
		evidence: [
			{
				traceIds: [POOL_TIMEOUT_TRACE],
				logPatterns: ["connection pool exhausted"],
				relatedServices: ["checkout-api"],
				note: "Pool wait dominates the slow charge spans; errors begin with the 3.5.0 pods.",
			},
		],
		suggestedActions: [
			"Roll payment-svc back to 3.4.1",
			"Restore the pool size before re-deploying 3.5.0",
		],
		confidence: "high" as const,
		ruledOut: ["Database CPU saturation", "Upstream card network latency"],
	},
	model: "maple-triage",
	severity: "critical" as const,
	confidence: "high" as const,
	seeded_by: "system" as const,
	created_by: null,
	input_tokens: 48_210,
	output_tokens: 2_874,
	error: null,
	created_at: at(105),
	started_at: at(105),
	diagnosed_at: at(98),
	updated_at: at(98),
}

/** The diagnosed report, as its thread's `submit_diagnosis` turn returned it (`chat.ts`). */
export const INVESTIGATION_DIAGNOSED_REPORT = diagnosed.report

const running = {
	...diagnosed,
	id: INVESTIGATION_RUNNING_ID,
	status: "investigating" as const,
	subject: {
		type: "incident" as const,
		issue_id: null,
		incident_kind: "alert" as const,
		incident_id: ALERT_INCIDENT_ID,
	},
	snapshot: {
		...diagnosed.snapshot,
		title: "Payment p95 latency",
		facts: [{ label: "Rule", value: "Payment p95 latency" }],
	},
	progress: {
		stepCount: 2,
		steps: steps(3, [
			["service_overview", "Compared payment-svc against its 24h baseline"],
			["list_releases", "Checking recent payment-svc releases"],
		]),
		updatedAt: FROZEN_NOW_MS - 2 * MINUTE,
	},
	report: null,
	model: null,
	severity: null,
	confidence: null,
	seeded_by: "user" as const,
	created_by: acmeAdmin.userId,
	input_tokens: null,
	output_tokens: null,
	created_at: at(4),
	started_at: at(4),
	diagnosed_at: null,
	updated_at: at(2),
}

/** Yesterday's catalog-api throughput dip, closed after the traffic came back. */
const resolved = {
	...diagnosed,
	id: fixtureUuid(0x61, 3),
	status: "resolved" as const,
	subject: {
		type: "incident" as const,
		issue_id: null,
		incident_kind: "anomaly" as const,
		incident_id: fixtureUuid(0x60, 3),
	},
	snapshot: {
		...diagnosed.snapshot,
		title: "catalog-api throughput below baseline",
		scope: "catalog-api",
		status: "resolved",
		severity: "medium" as const,
		facts: [{ label: "Signal", value: "throughput" }],
		incidentStartedAt: at(19 * 60),
		incidentEndedAt: at(17 * 60),
	},
	report: {
		...diagnosed.report,
		summary:
			"catalog-api traffic dipped while the 2.15.0 pods warmed their caches; no requests failed and throughput recovered on its own.",
		suspectedCause: "Cold caches on the 2.15.0 rollout.",
		severityAssessment: "medium" as const,
		affectedScope: "catalog-api reads for about two hours.",
		suggestedActions: ["Pre-warm the product cache during rollouts"],
		confidence: "medium" as const,
	},
	severity: "medium" as const,
	confidence: "medium" as const,
	created_at: at(19 * 60 - 3),
	started_at: at(19 * 60 - 3),
	diagnosed_at: at(19 * 60 - 12),
	updated_at: at(16 * 60),
}

const INVESTIGATIONS = [running, diagnosed, resolved]

const encode = Schema.encodeUnknownEffect(V2Investigation)

/** The `investigation_v2` row the writer stores: camelCase jsonb, internal subject. */
const toRow = (investigation: (typeof INVESTIGATIONS)[number]): SyncedRow => ({
	id: investigation.id,
	org_id: acmeAdmin.orgId,
	status: investigation.status,
	seeded_by: investigation.seeded_by,
	subject_json: {
		type: "incident",
		incidentKind: investigation.subject.incident_kind,
		incidentId: investigation.subject.incident_id,
	},
	snapshot_json: investigation.snapshot,
	report_json: investigation.report,
	progress_json: investigation.progress,
	severity: investigation.severity,
	confidence: investigation.confidence,
	model: investigation.model,
	input_tokens: investigation.input_tokens,
	output_tokens: investigation.output_tokens,
	error: investigation.error,
	created_by: investigation.created_by,
	created_at: investigation.created_at,
	started_at: investigation.started_at,
	diagnosed_at: investigation.diagnosed_at,
	updated_at: investigation.updated_at,
})

export const investigationRows: ReadonlyArray<SyncedRow> = INVESTIGATIONS.map(toRow)

export const investigationDatasetEndpoints = {
	"investigations.list": ({ query }) =>
		Effect.gen(function* () {
			const status = str(query, "status")
			const kind = str(query, "incident_kind")
			const incident = str(query, "incident_id")
			const matching = INVESTIGATIONS.filter(
				(entry) =>
					(status === undefined || entry.status === status) &&
					(kind === undefined || entry.subject.incident_kind === kind) &&
					(incident === undefined || entry.subject.incident_id === incident) &&
					str(query, "issue_id") === undefined,
			)
			return list(yield* Effect.forEach(matching, (entry) => encode(entry)))
		}),
	// Nothing is persisted: a new investigation answers as the running one, which the detail page then reads.
	"investigations.create": () => encode(running),
	// Writes answer with the row as it would read after; the detail page re-reads the shape, which stays seeded.
	"investigations.updateStatus": ({ params }) =>
		encode({ ...(INVESTIGATIONS.find((entry) => entry.id === str(params, "id")) ?? diagnosed), status: "resolved" as const }),
	"investigations.restart": ({ params }) =>
		encode({ ...(INVESTIGATIONS.find((entry) => entry.id === str(params, "id")) ?? diagnosed), status: "investigating" as const }),
	"investigations.retrieve": ({ params }) =>
		Effect.gen(function* () {
			const found = INVESTIGATIONS.find((entry) => entry.id === str(params, "id"))
			if (found === undefined)
				return yield* new InvestigationNotFoundError({ message: "Investigation not found" })
			return yield* encode(found)
		}),
} satisfies Readonly<Record<string, EndpointHandler>>
