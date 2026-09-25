import { McpQueryError, type McpToolRegistrar } from "./types"
import { truncate } from "../lib/format"
import { Effect, Schema } from "effect"
import { ListAlertChecksOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { ALERT_CHECK_STATUSES, parseRuleId, ruleNotFound } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"

/** A week covers a paused or slow rule's recent checks; `limit` bounds the rows either way. */
const WINDOW = P.timeWindow({ defaultHours: 7 * 24 })
/** Rows the text shows; the rest stay in the structured output. */
const SHOWN_ROWS = 100

/** Window bounds are `YYYY-MM-DD HH:mm:ss` UTC; the read model parses ISO 8601. */
const toIso = (value: string): string => `${value.replace(" ", "T")}Z`

export function registerListAlertChecksTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_checks",
		description:
			"List a rule's recent checks (one row per evaluation) with observed value, threshold, sample count and incident transition. Use it to tune thresholds, diagnose flapping, or see the near-misses before a breach.",
		parameters: Schema.Struct({
			rule_id: P.text("Alert rule ID"),
			group_key: P.optionalText("Only checks for this exact group key"),
			status: P.optionalOneOf(ALERT_CHECK_STATUSES, "Only checks with this status"),
			...WINDOW.fields,
			limit: P.limit({ default: 100, max: 2000, noun: "checks" }),
		}),
		aliases: { since: "start_time", until: "end_time" },
		output: ListAlertChecksOutput,
		hints: { readOnly: true },
		phrases: ["Reading alert check history"],
		handler: Effect.fn("McpTool.listAlertChecks")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const readModels = yield* AlertReadModelsService

			const ruleId = yield* parseRuleId(params.rule_id)
			const { st, et } = yield* WINDOW.resolve(params, "list_alert_checks")

			const result = yield* readModels
				.listRuleChecks(tenant.orgId, ruleId, {
					groupKey: params.group_key,
					status: params.status,
					since: toIso(st),
					until: toIso(et),
					limit: params.limit,
				})
				.pipe(
					Effect.catchTag("@maple/http/errors/AlertRuleNotFoundError", () =>
						Effect.fail(ruleNotFound(params.rule_id)),
					),
					Effect.mapError((error) =>
						error._tag === "@maple/mcp/errors/McpInvalidInputError"
							? error
							: new McpQueryError({
									message: error.message,
									pipeName: "list_alert_checks",
									cause: error,
								}),
					),
				)

			const checks = result.checks
			const count = (status: string) => checks.filter((c) => c.status === status).length

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				ruleId: params.rule_id,
				status: params.status ?? "all",
				"result.rowCount": checks.length,
			})

			return {
				ruleId: params.rule_id,
				total: checks.length,
				breached: count("breached"),
				healthy: count("healthy"),
				skipped: count("skipped"),
				errored: count("error"),
				transitions: checks.filter((c) => c.incidentTransition !== "none").length,
				checks: checks.map((c) => ({
					timestamp: c.timestamp,
					groupKey: c.groupKey,
					status: c.status,
					observedValue: c.observedValue,
					threshold: c.threshold,
					comparator: c.comparator,
					sampleCount: c.sampleCount,
					windowStart: c.windowStart,
					windowEnd: c.windowEnd,
					consecutiveBreaches: c.consecutiveBreaches,
					consecutiveHealthy: c.consecutiveHealthy,
					incidentId: c.incidentId,
					incidentTransition: c.incidentTransition,
					evaluationDurationMs: c.evaluationDurationMs,
					errorMessage: c.errorMessage,
					errorCategory: c.errorCategory,
				})),
				timeRange: { start: st, end: et },
				...(params.group_key === undefined ? undefined : { groupKey: params.group_key }),
				...(params.status === undefined ? undefined : { status: params.status }),
				limit: params.limit,
			}
		}),
		render: (output) => {
			const shown = output.checks.slice(0, SHOWN_ROWS)
			const oldestShown = shown.at(-1)
			// A full page means older checks may exist beyond it.
			const reachedLimit = output.limit !== undefined && output.total >= output.limit
			const next: Array<NextCall> = []
			if (output.errored > 0) {
				next.push(
					doc.next(
						"get_alert_rule",
						{ rule_id: output.ruleId },
						"evaluations are failing: read its last evaluation error and fix the rule's query",
					),
				)
			}
			if (output.transitions > 0) {
				next.push(doc.next("list_alert_incidents", {}, "follow up on the triggered incidents"))
			}
			if (output.breached > 0 && output.transitions === 0) {
				next.push(
					doc.next(
						"get_alert_rule",
						{ rule_id: output.ruleId },
						"rule breached but no incident opened: check consecutiveBreachesRequired",
					),
				)
			}
			if (next.length === 0) {
				next.push(
					doc.next(
						"get_alert_rule",
						{ rule_id: output.ruleId },
						"review this rule's configuration",
					),
				)
			}

			return {
				title: "Alert Checks",
				scope: [
					["Rule", output.ruleId],
					[
						"Time range",
						output.timeRange ? `${output.timeRange.start} to ${output.timeRange.end}` : undefined,
					],
					["Group", output.groupKey],
					["Status", output.status],
				],
				...(output.checks.length === 0
					? {
							empty: {
								message: "No checks found for the given filters.",
								hints: [
									"Widen start_time/end_time, or drop the status and group_key filters.",
									"A disabled rule records no checks.",
								],
							},
						}
					: undefined),
				blocks:
					output.checks.length === 0
						? []
						: [
								doc.text(
									`Total: ${output.total} (${output.breached} breached, ${output.healthy} healthy, ${output.skipped} skipped, ${output.errored} errored, ${output.transitions} incident transitions)`,
								),
								doc.table(
									[
										"Time",
										"Status",
										"Value",
										"Threshold",
										"Samples",
										"Group",
										"Transition",
										"Eval ms",
									],
									shown.map((c) => [
										c.timestamp.slice(0, 19),
										c.status,
										c.status === "error" && c.errorMessage != null
											? truncate(c.errorMessage, 40)
											: c.observedValue != null
												? String(c.observedValue)
												: "-",
										String(c.threshold),
										String(c.sampleCount),
										truncate(c.groupKey || "all", 20),
										c.incidentTransition,
										String(c.evaluationDurationMs),
									]),
								),
							],
				...(output.checks.length > shown.length || reachedLimit
					? {
							truncation: {
								shown: shown.length,
								...(reachedLimit ? undefined : { total: output.total }),
								noun: "checks",
								...(oldestShown === undefined || output.timeRange === undefined
									? undefined
									: {
											next: doc.next(
												"list_alert_checks",
												{
													rule_id: output.ruleId,
													start_time: output.timeRange.start,
													end_time: oldestShown.timestamp
														.slice(0, 19)
														.replace("T", " "),
													group_key: output.groupKey,
													status: output.status,
												},
												"older checks",
											),
										}),
							},
						}
					: undefined),
				next,
			}
		},
	})
}
