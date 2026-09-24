import type { McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema } from "effect"
import { GetAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { formatCondition, ruleNotFound, toAlertRuleRow } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

export function registerGetAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "get_alert_rule",
		description:
			"Get full configuration details of a specific alert rule including thresholds, service filters, evaluation settings, and notification destinations. Use list_alert_rules to find rule IDs.",
		parameters: Schema.Struct({
			rule_id: P.text("Alert rule ID"),
		}),
		output: GetAlertRuleOutput,
		hints: { readOnly: true },
		phrases: ["Reading an alert rule"],
		handler: Effect.fn("McpTool.getAlertRule")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertRulesService

			const result = yield* alerts
				.listRules(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("get_alert_rule")))

			const rule = result.rules.find((r) => r.id === params.rule_id)
			if (!rule) return yield* ruleNotFound(params.rule_id)

			return {
				rule: {
					...toAlertRuleRow(rule),
					excludeServiceNames: [...rule.excludeServiceNames],
					groupBy: rule.groupBy ? [...rule.groupBy] : null,
					minimumSampleCount: rule.minimumSampleCount,
					consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
					consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
					renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					apdexThresholdMs: rule.apdexThresholdMs,
					queryBuilderDraft: rule.queryBuilderDraft,
					rawQuerySql: rule.rawQuerySql,
					rawQueryReducer: rule.rawQueryReducer,
					thresholdUpper: rule.thresholdUpper,
					notificationTitle: rule.notificationTemplate?.title ?? null,
					notificationBody: rule.notificationTemplate?.body ?? null,
					lastEvaluationError: rule.lastEvaluationError,
					lastEvaluatedAt: rule.lastEvaluatedAt,
				},
			}
		}),
		render: ({ rule }) => {
			const blocks: Array<DocBlock> = [
				doc.fields([
					["ID", rule.id],
					["Status", rule.enabled ? "Enabled" : "Disabled"],
					["Severity", rule.severity],
					["Signal", rule.signalType],
					["Condition", formatCondition(rule)],
					["Window", `${rule.windowMinutes}m`],
					["Last evaluated", rule.lastEvaluatedAt ?? undefined],
					["Last evaluation error", rule.lastEvaluationError ?? undefined],
				]),
				doc.heading("Scope"),
				doc.fields([
					[
						"Service Names",
						rule.serviceNames.length > 0 ? rule.serviceNames.join(", ") : "All services",
					],
					[
						"Exclude",
						rule.excludeServiceNames.length > 0 ? rule.excludeServiceNames.join(", ") : undefined,
					],
					[
						"Environments",
						rule.environments.length > 0 ? rule.environments.join(", ") : "All environments",
					],
					[
						"Group By",
						rule.groupBy && rule.groupBy.length > 0 ? rule.groupBy.join(", ") : undefined,
					],
				]),
				doc.heading("Evaluation"),
				doc.fields([
					["Minimum Sample Count", rule.minimumSampleCount],
					["Consecutive Breaches Required", rule.consecutiveBreachesRequired],
					["Consecutive Healthy Required", rule.consecutiveHealthyRequired],
					["Renotify Interval", `${rule.renotifyIntervalMinutes}m`],
				]),
			]

			if (rule.apdexThresholdMs) {
				blocks.push(
					doc.heading("Apdex Configuration"),
					doc.fields([["Apdex Threshold", `${rule.apdexThresholdMs}ms`]]),
				)
			}

			if (rule.signalType === "builder_query" && rule.queryBuilderDraft) {
				blocks.push(
					doc.heading("Query Builder"),
					doc.fields([
						["Data Source", rule.queryBuilderDraft.dataSource],
						["Aggregation", rule.queryBuilderDraft.aggregation],
						["Where", rule.queryBuilderDraft.whereClause || undefined],
					]),
				)
			}

			if (rule.signalType === "raw_query" && rule.rawQuerySql) {
				blocks.push(doc.heading("Raw SQL Query"), doc.code("sql", rule.rawQuerySql))
				if (rule.rawQueryReducer) blocks.push(doc.fields([["Reducer", rule.rawQueryReducer]]))
			}

			blocks.push(
				doc.heading("Notifications"),
				doc.text(
					rule.destinationIds.length > 0
						? `Destination IDs: ${rule.destinationIds.join(", ")}`
						: "No notification destinations configured.",
				),
			)

			if (rule.notificationTitle || rule.notificationBody) {
				blocks.push(doc.heading("Message Template"))
				if (rule.notificationTitle) blocks.push(doc.fields([["Title", rule.notificationTitle]]))
				if (rule.notificationBody) blocks.push(doc.text("Body:"), doc.code("", rule.notificationBody))
			}

			return {
				title: `Alert Rule: ${rule.name}`,
				blocks,
				next: [
					doc.next(
						"list_alert_checks",
						{ rule_id: rule.id },
						"recent evaluations: observed values and near-misses",
					),
					doc.next("get_incident_timeline", { rule_id: rule.id }, "incident history for this rule"),
				],
			}
		},
	})
}
