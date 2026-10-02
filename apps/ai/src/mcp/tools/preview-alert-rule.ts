import { McpInvalidInputError, McpQueryBudgetError, type McpToolRegistrar } from "./types"
import { Effect, Schema, Struct } from "effect"
import { IsoDateTimeString } from "@maple/domain"
import { AlertRulePreviewRequest, type AlertRulePreviewResponse } from "@maple/domain/http"
import { PreviewAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { rawAlertSampleCountWarning } from "@maple/domain/raw-sql"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { toMcpHttpError } from "../lib/map-http-error"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatCondition, ruleNotFound } from "../lib/alert-rules"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"
import { buildAlertRuleRequest, CreateAlertRuleParameters } from "./create-alert-rule"
import { buildUpdatedRequest } from "./update-alert-rule"

const WINDOW = P.timeWindow({ defaultHours: 24, maxHours: 7 * 24 })
/** Most recent windows the text shows per group; the rest stay in the structured output. */
const SHOWN_POINTS = 12
const SHOWN_GROUPS = 20
/** Latest windows per group kept in the structured output; group counts cover the whole range. */
const POINTS_PER_GROUP = 200

type Output = typeof PreviewAlertRuleOutput.Type

const decodePreviewRequest = Schema.decodeUnknownEffect(AlertRulePreviewRequest)
const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

/** Window bounds are `YYYY-MM-DD HH:mm:ss` UTC; the preview takes ISO 8601. */
const toIso = (value: string) => decodeIsoDateTimeString(`${value.replace(" ", "T")}Z`)

const Parameters = Schema.Struct({
	rule_id: P.optionalText(
		"Existing rule to preview (list_alert_rules). Definition params you also pass override its saved config, so a change can be tried before update_alert_rule. `template` is ignored with rule_id.",
	),
	// The rule definition, exactly as create_alert_rule takes it; naming and delivery do not affect evaluation.
	...Struct.omit(CreateAlertRuleParameters.fields, [
		"name",
		"destination_ids",
		"severity",
		"enabled",
		"notification_title",
		"notification_body",
	]),
	...WINDOW.fields,
})

const skipLabel = (reason: string | null): string => {
	switch (reason) {
		case "no_data":
			return "no data"
		case "below_min_samples":
			return "below min samples"
		case "no_value":
			return "no value"
		default:
			return "skipped"
	}
}

const summarizeGroups = (preview: AlertRulePreviewResponse): Output["groups"] =>
	preview.series.map((series) => {
		const values = series.points.flatMap((p) => (p.value === null ? [] : [p.value]))
		const count = (predicate: (p: (typeof series.points)[number]) => boolean) =>
			series.points.filter(predicate).length
		return {
			groupKey: series.groupKey,
			windows: series.points.length,
			breached: count((p) => p.status === "breached"),
			healthy: count((p) => p.status === "healthy"),
			noData: count((p) => p.skipReason === "no_data"),
			belowMinSamples: count((p) => p.skipReason === "below_min_samples"),
			noValue: count((p) => p.skipReason === "no_value"),
			minValue: values.length > 0 ? Math.min(...values) : null,
			maxValue: values.length > 0 ? Math.max(...values) : null,
			totalSamples: series.points.reduce((sum, p) => sum + p.sampleCount, 0),
		}
	})

/** What an agent would otherwise only learn after saving the rule and waiting for checks. */
const previewWarnings = (
	groups: Output["groups"],
	clamped: boolean,
	rule: {
		readonly signalType: string
		readonly rawQuerySql?: string | null
		readonly minimumSampleCount: number
	},
): ReadonlyArray<string> => {
	const windows = groups.reduce((sum, g) => sum + g.windows, 0)
	const noData = groups.reduce((sum, g) => sum + g.noData, 0)
	const belowMin = groups.reduce((sum, g) => sum + g.belowMinSamples, 0)
	const warnings: Array<string> = []
	if (windows > 0 && noData === windows) {
		warnings.push(
			`Every window had no data: the query matched nothing in this range. Saved as is, every check would be skipped, which reads as quiet, not healthy. Check the filters${clamped ? "; the range was already clamped to the preview cap, so try a longer window_minutes rather than an earlier start_time" : ", or widen start_time"}.`,
		)
	} else if (windows > 0 && belowMin === windows) {
		warnings.push(
			`Every window had fewer than ${rule.minimumSampleCount} samples, so every check would be skipped. Lower minimum_sample_count or widen window_minutes.`,
		)
	}
	if (rule.signalType === "raw_query" && rule.rawQuerySql != null) {
		const warning = rawAlertSampleCountWarning(rule.rawQuerySql, rule.minimumSampleCount)
		if (warning !== null) warnings.push(warning)
	}
	return warnings
}

const formatValue = (value: number | null): string => (value === null ? "-" : String(value))

export function registerPreviewAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "preview_alert_rule",
		title: "Preview Alert Rule",
		description:
			"Replay an alert rule over past data without saving it: per evaluation window, the value, sample count and verdict the scheduler would produce (breached, healthy, or skipped with the reason), plus when it would have fired. " +
			"Pass rule_id to preview a saved rule, optionally with overrides, or a create_alert_rule definition to dry-run a new one. Run it before saving a raw_query rule.",
		parameters: Parameters,
		aliases: { service_names: "services", since: "start_time", until: "end_time" },
		output: PreviewAlertRuleOutput,
		hints: { readOnly: true },
		phrases: ["Previewing an alert rule"],
		handler: Effect.fn("McpTool.previewAlertRule")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const { st, et } = yield* WINDOW.resolve(params, "preview_alert_rule")

			let rule: unknown
			if (params.rule_id !== undefined) {
				const rules = yield* AlertRulesService
				const list = yield* rules
					.listRules(tenant.orgId)
					.pipe(Effect.mapError(toMcpHttpError("preview_alert_rule")))
				const current = list.rules.find((r) => r.id === params.rule_id)
				if (!current) return yield* ruleNotFound(params.rule_id)
				rule = buildUpdatedRequest(current, { ...params, rule_id: current.id })
			} else {
				rule = yield* buildAlertRuleRequest({ ...params, name: "Preview", destination_ids: [] })
			}

			const request = yield* decodePreviewRequest({
				rule,
				startTime: toIso(st),
				endTime: toIso(et),
			}).pipe(
				Effect.mapError(
					(error) => new McpInvalidInputError({ message: `Invalid alert rule: ${String(error)}` }),
				),
			)

			const alerts = yield* AlertsService
			const preview = yield* alerts.previewRule(tenant.orgId, tenant.roles, request).pipe(
				Effect.catchTags({
					"@maple/http/errors/AlertValidationError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message: [`Invalid alert rule: ${error.message}`, ...error.details].join(
									"\n",
								),
							}),
						),
					"@maple/http/errors/AlertForbiddenError": (error) =>
						Effect.fail(toMcpHttpError("preview_alert_rule")(error)),
					"@maple/http/errors/QueryEngineValidationError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message:
									error.details.length > 0
										? `${error.message}\n${error.details.join("\n")}`
										: error.message,
							}),
						),
					"@maple/http/errors/QueryEngineTimeoutError": () =>
						Effect.fail(
							new McpQueryBudgetError({
								message: "The preview ran past its time limit. Narrow start_time/end_time.",
								pipeName: "preview_alert_rule",
								setting: "max_execution_time",
							}),
						),
					...warehouseReadToMcpHandlers("preview_alert_rule"),
					// Raw-SQL rules mint a per-org warehouse token; ordinary reads do not.
					"@maple/http/errors/TinybirdOrgTokenConfigError": (error) =>
						Effect.fail(toMcpHttpError("preview_alert_rule")(error)),
					"@maple/http/errors/TinybirdOrgTokenMintError": (error) =>
						Effect.fail(toMcpHttpError("preview_alert_rule")(error)),
				}),
			)

			const groups = summarizeGroups(preview)
			const ruleRequest = request.rule
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.alert.signal_type": ruleRequest.signalType,
				"result.groupCount": groups.length,
			})

			return {
				...(params.rule_id === undefined ? undefined : { ruleId: params.rule_id }),
				timeRange: { start: st, end: et },
				truncatedToStart: preview.truncatedToStart,
				windowMinutes: preview.windowMinutes,
				comparator: preview.comparator,
				threshold: preview.threshold,
				thresholdUpper: preview.thresholdUpper,
				minimumSampleCount: ruleRequest.minimumSampleCount ?? 0,
				groups,
				points: preview.series.flatMap((series) =>
					series.points.slice(-POINTS_PER_GROUP).map((p) => ({
						groupKey: series.groupKey,
						bucket: p.bucket,
						status: p.status,
						skipReason: p.skipReason ?? null,
						value: p.value,
						sampleCount: p.sampleCount,
						provisional: p.provisional === true,
					})),
				),
				wouldFire: preview.wouldFire.map((span) => ({
					groupKey: span.groupKey,
					start: span.start,
					end: span.end,
				})),
				warnings: [
					...previewWarnings(groups, preview.truncatedToStart !== null, {
						signalType: ruleRequest.signalType,
						rawQuerySql: ruleRequest.rawQuerySql,
						minimumSampleCount: ruleRequest.minimumSampleCount ?? 0,
					}),
				],
			}
		}),
		render: (output) => {
			const shownGroups = output.groups.slice(0, SHOWN_GROUPS)
			const blocks: Array<DocBlock> = [
				doc.fields([
					["Condition", formatCondition(output)],
					["Window", `${output.windowMinutes}m`],
					["Minimum samples", output.minimumSampleCount],
					[
						"Would fire",
						output.wouldFire.length > 0 ? `${output.wouldFire.length} time(s)` : "never",
					],
				]),
				doc.table(
					[
						"Group",
						"Windows",
						"Breached",
						"Healthy",
						"No data",
						"Below min",
						"Min",
						"Max",
						"Samples",
					],
					shownGroups.map((g) => [
						truncate(g.groupKey, 30),
						String(g.windows),
						String(g.breached),
						String(g.healthy),
						String(g.noData),
						String(g.belowMinSamples),
						formatValue(g.minValue),
						formatValue(g.maxValue),
						String(g.totalSamples),
					]),
				),
			]

			// The latest windows of the first group: enough to see the shape without the whole series.
			const first = shownGroups[0]
			if (first !== undefined) {
				const recent = output.points.filter((p) => p.groupKey === first.groupKey).slice(-SHOWN_POINTS)
				blocks.push(
					doc.heading(`Latest windows: ${truncate(first.groupKey, 40)}`),
					doc.table(
						["Window start", "Verdict", "Value", "Samples"],
						recent.map((p) => [
							`${p.bucket.slice(0, 19)}${p.provisional ? " (in progress)" : ""}`,
							p.status === "skipped" ? skipLabel(p.skipReason) : p.status,
							formatValue(p.value),
							String(p.sampleCount),
						]),
					),
				)
			}

			if (output.wouldFire.length > 0) {
				blocks.push(
					doc.heading("Would have fired"),
					doc.table(
						["Group", "From", "To"],
						output.wouldFire
							.slice(0, SHOWN_GROUPS)
							.map((span) => [
								truncate(span.groupKey, 30),
								span.start.slice(0, 19),
								span.end.slice(0, 19),
							]),
					),
				)
			}

			const next: Array<NextCall> =
				output.ruleId === undefined
					? [
							doc.next(
								"list_alert_destinations",
								{},
								"destination ids for create_alert_rule once the preview looks right",
							),
						]
					: [
							doc.next(
								"list_alert_checks",
								{ rule_id: output.ruleId },
								"what the saved rule actually recorded",
							),
						]

			return {
				title: "Alert Rule Preview",
				scope: [
					["Rule", output.ruleId],
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Clamped to start", output.truncatedToStart ?? undefined],
				],
				...(output.warnings.length > 0 ? { notices: output.warnings } : undefined),
				...(output.groups.length === 0
					? { empty: { message: "The preview returned no series for this range." } }
					: undefined),
				blocks: output.groups.length === 0 ? [] : blocks,
				...(output.groups.length > shownGroups.length
					? {
							truncation: {
								shown: shownGroups.length,
								total: output.groups.length,
								noun: "groups",
							},
						}
					: undefined),
				next,
			}
		},
	})
}
