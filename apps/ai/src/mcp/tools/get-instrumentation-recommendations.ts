import { McpQueryError, type McpToolRegistrar } from "./types"
import { formatNumber } from "../lib/format"
import { Effect, Option, Schema } from "effect"
import { GetInstrumentationRecommendationsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { resolveTimeRange } from "../lib/time"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"
import type { RecommendationIssueKind } from "@maple/domain/http"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

export type RecommendationSeverity = "warn" | "info"

/**
 * Severity for the audit report. Renames and double-emissions degrade querying
 * (deprecated keys, split data) but Maple's fallback chains keep features working,
 * so nothing here is critical; naming advisories are stylistic.
 */
export const kindToSeverity = (kind: RecommendationIssueKind): RecommendationSeverity =>
	kind === "naming" ? "info" : "warn"

interface CoverageCheck {
	readonly checkId: string
	/** The gap is reported only when none of these resource keys arrive. */
	readonly keys: ReadonlyArray<string>
	readonly label: string
	readonly reason: string
}

// Org-wide resource-attribute presence checks. Check ids match skills/maple-audit/checks.md.
const COVERAGE_CHECKS: ReadonlyArray<CoverageCheck> = [
	{
		checkId: "RES-02",
		keys: ["service.version"],
		label: "service.version",
		reason: "No per-version slices on service overview.",
	},
	{
		checkId: "RES-03",
		keys: ["deployment.environment", "deployment.environment.name"],
		label: "deployment.environment(.name)",
		reason: "Environment filtering and per-env metrics are empty everywhere.",
	},
	{
		checkId: "RES-04",
		keys: ["vcs.repository.url.full"],
		label: "vcs.repository.url.full",
		reason: "Telemetry can't be linked back to the source repository.",
	},
	{
		checkId: "RES-05",
		keys: ["vcs.ref.head.revision"],
		label: "vcs.ref.head.revision",
		reason: "No release markers or per-deploy metrics.",
	},
]

export interface CoverageGap {
	readonly checkId: string
	readonly attribute: string
	readonly severity: "warn"
	readonly reason: string
}

/** Pure: which recommended resource attributes are absent from the org's live resource keys. */
export const deriveCoverageGaps = (
	resourceKeys: ReadonlyArray<{ readonly key: string }>,
): ReadonlyArray<CoverageGap> => {
	const present = new Set(resourceKeys.map((row) => row.key))
	return COVERAGE_CHECKS.filter((check) => !check.keys.some((key) => present.has(key))).map((check) => ({
		checkId: check.checkId,
		attribute: check.label,
		severity: "warn" as const,
		reason: check.reason,
	}))
}

// v2 candidates (each needs a new warehouse aggregate, deliberately not in v1):
// per-service coverage gaps, Client/Producer spans missing peer.service, and
// log records missing TraceId correlation.

export function registerGetInstrumentationRecommendationsTool(server: McpToolRegistrar) {
	server.define({
		name: "get_instrumentation_recommendations",
		description:
			"Audit instrumentation quality for the org: lists detected span attribute issues reconciled against live data " +
			"(deprecated semconv keys to rename, double-emitted old+new keys, non-conforming names) plus org-wide " +
			"resource-attribute coverage gaps (deployment environment, vcs.*, service.version). Renames can be fixed at " +
			"the SDK or by accepting the matching Recommendation Issue in Maple Settings → Ingestion (creates an ingest " +
			"attribute mapping); double-emission and naming issues must be fixed at the SDK. Used by the maple-audit skill.",
		parameters: Schema.Struct({
			status: P.optionalOneOf(
				["open", "dismissed", "applied", "resolved", "all"],
				"Filter issues by status (default: open)",
			),
			include_coverage: P.optionalFlag(
				"Set to false to skip the resource-attribute coverage section (default: included)",
			),
		}),
		output: GetInstrumentationRecommendationsOutput,
		hints: { readOnly: true },
		phrases: ["Checking instrumentation"],
		handler: Effect.fn("McpTool.getInstrumentationRecommendations")(function* ({
			status,
			include_coverage,
		}) {
			const tenant = yield* CurrentMcpTenant
			const statusFilter = status ?? "open"
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, status: statusFilter })

			// Reconciles live span keys against persisted issues: calling this tool refreshes
			// usage counts and auto-resolves fixed issues, same as the dashboard settings page.
			const service = yield* RecommendationIssueService
			const reconciled = yield* service.listReconciled(tenant).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "get_instrumentation_recommendations",
							cause: error,
						}),
				),
			)

			const issues = reconciled.issues.filter(
				(issue) => statusFilter === "all" || issue.status === statusFilter,
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", issues.length)

			// Coverage degrades gracefully: if the warehouse is unavailable the issue list
			// (possibly stale) still renders, with the coverage section marked unavailable.
			const wantCoverage = include_coverage !== false
			const range = resolveTimeRange(undefined, undefined, { defaultHours: 24 })
			const resourceKeysOpt = wantCoverage
				? yield* exploreAttributeKeys({
						source: "traces",
						scope: "resource",
						timeRange: { startTime: range.st, endTime: range.et },
						limit: 500,
					}).pipe(
						provideWarehouseExecutorFromTenant(tenant),
						Effect.mapError(toMcpQueryError("get_instrumentation_recommendations")),
						Effect.option,
					)
				: Option.none()

			return {
				issues: issues.map((issue) => ({
					id: issue.id,
					number: issue.number,
					recommendationKey: issue.recommendationKey,
					kind: issue.kind,
					severity: kindToSeverity(issue.kind),
					sourceKey: issue.sourceKey,
					canonicalKey: issue.canonicalKey ?? null,
					status: issue.status,
					usageCount: issue.usageCount,
					applyableAsMapping: issue.kind === "rename",
					openedAt: issue.openedAt,
					updatedAt: issue.updatedAt,
				})),
				coverage: {
					available: Option.isSome(resourceKeysOpt),
					included: wantCoverage,
					timeRange: { start: range.st, end: range.et },
					gaps: Option.isSome(resourceKeysOpt) ? deriveCoverageGaps(resourceKeysOpt.value) : [],
				},
				total: issues.length,
				statusFilter,
			}
		}),
		render: (output) => {
			const { issues, coverage } = output
			const coverageBlocks: Array<DocBlock> = !coverage.included
				? []
				: [
						doc.heading("Resource attribute coverage (last 24h)"),
						!coverage.available
							? doc.text("Coverage check unavailable: the warehouse query failed.")
							: coverage.gaps.length === 0
								? doc.text("All recommended resource attributes are arriving.")
								: doc.table(
										["Check", "Missing attribute", "Severity", "Impact"],
										coverage.gaps.map((gap) => [
											gap.checkId,
											gap.attribute,
											gap.severity,
											gap.reason,
										]),
									),
					]
			const guidance = [
				...(issues.some((issue) => issue.kind === "rename")
					? [
							"Rename issues: fix at the SDK (preferred) or accept the issue in Maple Settings → Ingestion to create an ingest attribute mapping.",
						]
					: []),
				...(issues.some((issue) => issue.kind === "double-emission")
					? [
							"Double-emission issues: standardize on the canonical key at the SDK; a mapping can't merge keys.",
						]
					: []),
			]
			return {
				title: "Instrumentation Recommendations",
				scope: [
					["Status filter", output.statusFilter ?? "open"],
					["Issues", String(output.total)],
				],
				blocks: [
					issues.length === 0
						? doc.text("No attribute issues detected in the last 24h of span data.")
						: doc.table(
								[
									"#",
									"Kind",
									"Severity",
									"Key",
									"Canonical",
									"Usage (24h)",
									"Status",
									"Fix via",
								],
								issues.map((issue) => [
									`#${issue.number}`,
									issue.kind,
									issue.severity,
									issue.sourceKey,
									issue.canonicalKey ?? "—",
									formatNumber(issue.usageCount),
									issue.status,
									issue.applyableAsMapping ? "SDK or ingest mapping" : "SDK only",
								]),
							),
					...coverageBlocks,
					...(guidance.length === 0 ? [] : [doc.list(guidance)]),
				],
				next: [
					doc.next(
						"explore_attributes",
						{ source: "traces", scope: "resource" },
						"see every resource attribute key arriving",
					),
				],
			}
		},
	})
}
