import { McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { AuditSetupOutput } from "@maple/domain/mcp-outputs"
import { PublicIdPrefixes, encodePublicId, type PublicIdPrefix } from "@maple/domain/http/v2"
import { INTEGRATION_PROVIDERS } from "@maple/domain/integration-inventory"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import type {
	AuditAffectedEntity,
	AuditCheckResult,
	AuditSeverity,
	SetupAuditReport,
} from "@maple/domain/setup-audit"
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

const SEVERITIES: ReadonlyArray<AuditSeverity> = ["critical", "warn", "info"]
const SEVERITY_MEANING: Record<AuditSeverity, string> = {
	critical: "alerts or data are being lost, or a secret is exposed; fix these first",
	warn: "a feature is degraded",
	info: "advisory",
} satisfies Record<AuditSeverity, string>

type RankedCheck = Pick<AuditCheckResult, "id" | "status" | "severity" | "affectedCount">

/** Within a severity, checks naming more broken entities come first; the id keeps runs stable. */
export const byUrgency = (a: RankedCheck, b: RankedCheck) => {
	const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status]
	if (byStatus !== 0) return byStatus
	const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
	if (bySeverity !== 0) return bySeverity
	const byAffected = b.affectedCount - a.affectedCount
	if (byAffected !== 0) return byAffected
	return Str.localeCompare(b.id)(a.id)
}

/**
 * Clipped before `max` at a sentence end, else before a parenthetical, else at a word boundary,
 * so a tool name or id is never cut in half.
 */
export const clipWords = (text: string, max: number): string => {
	if (text.length <= max) return text
	const head = Str.slice(0, max - 1)(text)
	const atLeastHalf = (index: number) => index >= max / 2
	// A period followed by a capital, so `e.g. trace` is not read as a sentence end.
	const sentenceEnd = Option.filter(
		Option.map(Arr.last(Arr.fromIterable(head.matchAll(/\.\s+(?=[A-Z])/g))), (match) => match.index + 1),
		atLeastHalf,
	)
	const cut = Option.getOrElse(
		Arr.findFirst(
			[
				sentenceEnd,
				Option.filter(Str.lastIndexOf(" (")(head), atLeastHalf),
				Option.filter(Str.lastIndexOf(" ")(head), atLeastHalf),
				Option.filter(Str.lastIndexOf(" ")(head), (index) => index > 0),
			],
			(candidate) => candidate,
		),
		() => head.length,
	)
	const kept = Str.trimEnd(Str.slice(0, cut)(head))
	return Str.endsWith(".")(kept) ? `${kept} …` : `${kept}…`
}

/** Kinds the agent tools address by public id, encoded the way the v2 route does. */
const PUBLIC_ID_PREFIX_BY_KIND: Partial<Record<AuditAffectedEntity["kind"], PublicIdPrefix>> = {
	alert_rule: PublicIdPrefixes.alertRule,
	alert_destination: PublicIdPrefixes.alertDestination,
	attribute_mapping: PublicIdPrefixes.attributeMapping,
	scrape_target: PublicIdPrefixes.scrapeTarget,
} satisfies Partial<Record<AuditAffectedEntity["kind"], PublicIdPrefix>>

const publicIdOf = (entity: AuditAffectedEntity): string | undefined => {
	const prefix = PUBLIC_ID_PREFIX_BY_KIND[entity.kind]
	return prefix === undefined || entity.id === undefined ? undefined : encodePublicId(prefix, entity.id)
}

type OutputCheck = (typeof AuditSetupOutput.Type)["checks"][number]
type AffectedLike = Pick<OutputCheck, "affected" | "affectedCount">

const MAX_SHOWN_AFFECTED = 3
const MAX_NOTE_CHARS = 64
const MAX_FINDING_CHARS = 160

/** Affected entities inline into the table cell: the agent reads them as evidence, not as a list. */
export const formatAffected = (check: AffectedLike): string => {
	const named = Arr.map(Arr.take(check.affected, MAX_SHOWN_AFFECTED), (entity) => ({
		label: entity.id === undefined ? entity.name : `${entity.name} [${entity.id}]`,
		note: entity.note === null || entity.note === "" ? undefined : clipWords(entity.note, MAX_NOTE_CHARS),
	}))
	if (!Arr.isArrayNonEmpty(named)) return "-"
	// Entities sharing one note (`traces only`) print it once, after the last of them.
	const shown = Arr.join(
		Arr.map(
			Arr.groupWith(named, (a, b) => a.note === b.note),
			(group) => {
				const labels = Arr.join(
					Arr.map(group, (entity) => entity.label),
					", ",
				)
				const note = Arr.headNonEmpty(group).note
				return note === undefined ? labels : `${labels} (${note})`
			},
		),
		"; ",
	)
	const hidden = check.affectedCount - named.length
	return hidden > 0 ? `${shown}; +${hidden} more` : shown
}

const TRACE_ID = /\btrace ([0-9a-f]{16,32})\b/i
const ALERT_RULE_CHECKS: ReadonlySet<string> = new Set(["CFG-ALERT-02", "CFG-ALERT-03", "CFG-ALERT-05"])
const DESTINATION_CHECKS: ReadonlySet<string> = new Set(["CFG-ALERT-01", "CFG-ALERT-04"])

/** The one call that best starts fixing `check`, with arguments taken from its evidence. */
const nextCallsFor = (check: OutputCheck, openRecommendations: number): ReadonlyArray<NextCall> => {
	if (ALERT_RULE_CHECKS.has(check.id)) {
		const rule = Arr.findFirst(
			check.affected,
			(entity) => entity.kind === "alert_rule" && entity.id !== undefined,
		)
		return Option.match(rule, {
			onNone: () => [],
			onSome: (entity) => [
				doc.next(
					"get_alert_rule",
					{ rule_id: entity.id },
					`${check.id}: "${entity.name}", then fix it with update_alert_rule`,
				),
			],
		})
	}
	if (DESTINATION_CHECKS.has(check.id)) {
		return [
			doc.next("list_alert_destinations", {}, `${check.id}: see which destinations exist and deliver`),
		]
	}
	if (check.id === "CFG-NOTIF-01") {
		return [
			doc.next(
				"get_error_notification_policy",
				{},
				`${check.id}: read the policy, then set its destinations`,
			),
		]
	}
	if (check.category === "traces") {
		const traceId = Arr.findFirst(check.affected, (entity) =>
			Option.fromNullishOr(entity.note === null ? undefined : TRACE_ID.exec(entity.note)?.[1]),
		)
		return Option.match(traceId, {
			onNone: () => [],
			onSome: (id) => [
				doc.next("inspect_trace", { trace_id: id }, `${check.id}: see the gap in a real trace`),
			],
		})
	}
	if (check.id === "CFG-ATTR-01" || (Str.startsWith("NAME-")(check.id) && openRecommendations > 0)) {
		return [
			doc.next("get_instrumentation_recommendations", {}, `${check.id}: the exact attribute renames`),
		]
	}
	if (check.category === "integrations") {
		const detail = Str.toLowerCase(check.detail ?? check.title)
		const provider = Arr.findFirst(INTEGRATION_PROVIDERS, (name) =>
			Str.includes(Str.replace("_", " ")(name))(detail),
		)
		return [
			doc.next(
				"list_integrations",
				{ provider: Option.getOrUndefined(provider) },
				`${check.id}: which integration resources fail and why`,
			),
		]
	}
	return []
}

const MAX_NEXT_CALLS = 5

/**
 * One call per tool, most urgent check first. Two integration checks for different providers
 * collapse into one unfiltered `list_integrations`.
 */
export const nextCallsOf = (
	failing: ReadonlyArray<OutputCheck>,
	openRecommendations: number,
): ReadonlyArray<NextCall> => {
	const merged = Arr.reduce(
		Arr.flatMap(failing, (check) => nextCallsFor(check, openRecommendations)),
		Arr.empty<NextCall>(),
		(calls, call) => {
			const existing = Arr.findFirstIndex(calls, (prior) => prior.tool === call.tool)
			if (Option.isNone(existing)) return Arr.append(calls, call)
			const prior = calls[existing.value]
			if (call.tool !== "list_integrations" || prior?.args.provider === call.args.provider) return calls
			return Arr.map(calls, (kept, index) =>
				index === existing.value
					? doc.next("list_integrations", {}, "several integrations report failures")
					: kept,
			)
		},
	)
	const withRecommendations =
		openRecommendations > 0 &&
		!Arr.some(merged, (call) => call.tool === "get_instrumentation_recommendations")
			? Arr.append(
					merged,
					doc.next(
						"get_instrumentation_recommendations",
						{},
						`${openRecommendations} open attribute recommendation(s) with the exact renames`,
					),
				)
			: merged
	return Arr.take(withRecommendations, MAX_NEXT_CALLS)
}

export function registerAuditSetupTool(server: McpToolRegistrar) {
	server.define({
		name: "audit_setup",
		title: "Audit Setup",
		description:
			"Audit the organization's whole Maple setup and report every check with its outcome: alert routing and " +
			"delivery (rules that will never notify anyone), error-notification wiring, what each service actually " +
			"ingests (trace/log/metric coverage, service.name mismatches), attribute and semantic-convention quality, " +
			"trace completeness (orphan spans, traces with no root) and integration health. Telemetry-backed checks " +
			"skip when the warehouse is unavailable; configuration checks always run. Answers 'is my Maple setup " +
			"correct' and 'why didn't anything alert me'. `get_instrumentation_recommendations` is the per-attribute " +
			"rename list; whether data is arriving right now is ingest_freshness / list_ingest_sources.",
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
				"maple.audit.data_status": report.dataStatus,
				"maple.audit.critical": report.summary.critical,
				"maple.audit.warn": report.summary.warn,
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
			const visible = Arr.filter(
				[...output.checks],
				(check) => showAll || check.status === "fail",
			).sort(byUrgency)
			const failing = Arr.filter(visible, (check) => check.status === "fail")
			return {
				title: "Setup Audit",
				notices: output.telemetryChecksAvailable
					? []
					: [
							"Telemetry could not be read, so every telemetry-backed check was skipped. The configuration findings below still apply.",
						],
				blocks: [
					doc.text(
						`${summary.critical} critical · ${summary.warn} warn · ${summary.info} info · ${summary.pass} passing · ${summary.skip} skipped${
							!showAll && summary.pass + summary.skip > 0
								? " (passing and skipped hidden; `include_passing=true` lists them)"
								: ""
						}`,
					),
					...(visible.length === 0
						? [doc.text("No findings: every check passed.")]
						: Arr.flatMap(SEVERITIES, (severity) => {
								const rows = Arr.filter(visible, (check) => check.severity === severity)
								return rows.length === 0
									? []
									: [
											doc.heading(
												`${severity} (${rows.length}): ${SEVERITY_MEANING[severity]}`,
											),
											doc.table(
												showAll
													? ["Check", "Status", "Finding", "Affected", "Fix"]
													: ["Check", "Finding", "Affected", "Fix"],
												Arr.map(rows, (check) => [
													check.id,
													...(showAll ? [check.status] : []),
													clipWords(check.detail ?? check.title, MAX_FINDING_CHARS),
													formatAffected(check),
													check.status === "fail" ? check.fixHint : "-",
												]),
											),
										]
							})),
				],
				next: nextCallsOf(failing, output.openRecommendationCount),
			}
		},
	})
}

export const toStructured = (report: SetupAuditReport): typeof AuditSetupOutput.Type => ({
	generatedAt: new Date(report.generatedAt).toISOString(),
	dataStatus: report.dataStatus,
	telemetryChecksAvailable: report.warehouseAvailable,
	summary: report.summary,
	checks: Arr.map(report.checks, (check) => ({
		id: check.id,
		category: check.category,
		title: check.title,
		severity: check.severity,
		status: check.status,
		detail: check.detail,
		affected: Arr.map(check.affected, (entity) => {
			const id = publicIdOf(entity)
			const row = { kind: entity.kind, name: entity.name, note: entity.note ?? null }
			return id === undefined ? row : { ...row, id }
		}),
		affectedCount: check.affectedCount,
		fixHint: check.fixHint,
	})),
	openRecommendationCount: report.openRecommendationCount,
})
