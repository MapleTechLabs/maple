import { McpQueryError, type McpToolRegistrar } from "./types"
import { truncate } from "../lib/format"
import { Effect, Schema } from "effect"
import { AuditSetupOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import type { AuditCheckResult, AuditSeverity, SetupAuditReport } from "@maple/domain/setup-audit"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"

/** Fail-first, then by severity, so the table's top rows are the ones worth acting on. */
const SEVERITY_RANK: Record<AuditSeverity, number> = { critical: 0, warn: 1, info: 2 } satisfies Record<
	AuditSeverity,
	number
>
const STATUS_RANK: Record<AuditCheckResult["status"], number> = {
	fail: 0,
	skip: 1,
	pass: 2,
} satisfies Record<AuditCheckResult["status"], number>

type RankedCheck = Pick<AuditCheckResult, "id" | "status" | "severity">

export const byUrgency = (a: RankedCheck, b: RankedCheck) =>
	STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
	SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
	a.id.localeCompare(b.id)

interface AffectedLike {
	readonly affected: ReadonlyArray<{ readonly name: string; readonly note?: string | null | undefined }>
	readonly affectedCount: number
}

/** Affected entities inline into the table cell: the agent reads them as evidence, not as a list. */
export const formatAffected = (check: AffectedLike): string => {
	if (check.affected.length === 0) return "—"
	const shown = check.affected
		.slice(0, 3)
		.map((entity) => (entity.note ? `${entity.name} (${entity.note})` : entity.name))
		.join("; ")
	const hidden = check.affectedCount - Math.min(check.affected.length, 3)
	return truncate(hidden > 0 ? `${shown}; +${hidden} more` : shown, 160)
}

export function registerAuditSetupTool(server: McpToolRegistrar) {
	server.define({
		name: "audit_setup",
		description:
			"Audit the organization's whole Maple setup and report every check with its outcome: alert routing and " +
			"delivery (rules that will never notify anyone), error-notification wiring, what each service actually " +
			"ingests (trace/log/metric coverage, service.name mismatches), attribute and semantic-convention quality, " +
			"trace completeness (orphan spans, traces with no root) and integration health. Telemetry-backed checks " +
			"skip when the warehouse is unavailable; configuration checks always run. Answers 'is my Maple setup " +
			"correct' and 'why didn't anything alert me'. `get_instrumentation_recommendations` is the per-attribute " +
			"rename list.",
		parameters: Schema.Struct({
			include_passing: P.optionalFlag(
				"Also list passing and skipped checks (default false: findings only)",
			),
		}),
		output: AuditSetupOutput,
		hints: { readOnly: true },
		phrases: ["Auditing the setup", "Checking the telemetry setup"],
		handler: Effect.fn("McpTool.auditSetup")(function* ({ include_passing }) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* SetupAuditService
			const report = yield* service.run(tenant).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "audit_setup",
							cause: error,
						}),
				),
			)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"audit.dataStatus": report.dataStatus,
				"audit.critical": report.summary.critical,
				"audit.warn": report.summary.warn,
				"result.rowCount": report.checks.length,
			})

			return { ...toStructured(report), includePassing: include_passing === true }
		}),
		render: (output) => {
			if (output.dataStatus === "no_data") {
				return {
					title: "Setup Audit",
					empty: {
						message:
							"This organization has never received telemetry, so no checks were run. Connect a service first: Settings, Ingestion has the endpoint and keys.",
					},
					blocks: [],
				}
			}
			const { summary } = output
			const showAll = output.includePassing === true
			const visible = [...output.checks]
				.filter((check) => showAll || check.status === "fail")
				.sort(byUrgency)
			const next: Array<NextCall> =
				output.openRecommendationCount > 0
					? [
							doc.next(
								"get_instrumentation_recommendations",
								{},
								`${output.openRecommendationCount} open attribute recommendation(s) with the exact renames`,
							),
						]
					: []
			const guidance = [
				...(summary.critical > 0
					? ["Fix the `critical` rows first: each one breaks a Maple feature outright."]
					: []),
				...(output.checks.some((check) => check.category === "traces" && check.status === "fail")
					? [
							"Call `inspect_trace` on one of the sampled trace ids above to see the gap in a real waterfall.",
						]
					: []),
			]
			return {
				title: "Setup Audit",
				notices: output.telemetryChecksAvailable
					? []
					: [
							"Telemetry could not be read, so every telemetry-backed check was skipped. The configuration findings below still apply.",
						],
				blocks: [
					doc.text(
						`${summary.critical} critical · ${summary.warn} warn · ${summary.info} info · ${summary.pass} passing · ${summary.skip} skipped`,
					),
					visible.length === 0
						? doc.text("No findings: every check passed.")
						: doc.table(
								["Check", "Severity", "Status", "Finding", "Affected", "Fix"],
								visible.map((check) => [
									check.id,
									check.severity,
									check.status,
									truncate(check.detail ?? check.title, 200),
									formatAffected(check),
									truncate(check.fixHint, 160),
								]),
							),
					...(!showAll && (summary.pass > 0 || summary.skip > 0)
						? [
								doc.text(
									`${summary.pass} passing and ${summary.skip} skipped checks hidden. Pass \`include_passing=true\` to see them.`,
								),
							]
						: []),
					...(guidance.length === 0 ? [] : [doc.list(guidance)]),
				],
				next,
			}
		},
	})
}

const toStructured = (report: SetupAuditReport): typeof AuditSetupOutput.Type => ({
	generatedAt: new Date(report.generatedAt).toISOString(),
	dataStatus: report.dataStatus,
	telemetryChecksAvailable: report.warehouseAvailable,
	summary: report.summary,
	checks: report.checks.map((check) => ({
		id: check.id,
		category: check.category,
		title: check.title,
		severity: check.severity,
		status: check.status,
		detail: check.detail,
		affected: check.affected.map((entity) => ({
			kind: entity.kind,
			name: entity.name,
			note: entity.note ?? null,
		})),
		affectedCount: check.affectedCount,
		fixHint: check.fixHint,
	})),
	openRecommendationCount: report.openRecommendationCount,
})
