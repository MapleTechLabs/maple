import type { McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema } from "effect"
import { GetAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { formatCondition, ruleConfigWarnings, ruleNotFound, toAlertRuleRow } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

/** How the rule treats an empty window, in words. */
const noDataLabel = (behavior: string): string => {
	switch (behavior) {
		case "skip":
			return "skip the check (never breaches)"
		case "zero":
			return "read as 0"
		case "alert":
			return "breach (alerts when the rule goes blind)"
		default:
			return behavior
	}
}

export function registerGetAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "get_alert_rule",
		title: "Get Alert Rule",
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

			// Names only decorate the ids, so a failed destination read still returns the rule.
			const known = yield* (yield* AlertsService).listDestinations(tenant.orgId).pipe(
				Effect.map((r) => r.destinations),
				Effect.orElseSucceed(() => undefined),
			)
			const destinations =
				known === undefined
					? undefined
					: rule.destinationIds.map((id) => {
							const match = known.find((d) => d.id === id)
							return {
								id,
								name: match?.name ?? null,
								type: match?.type ?? null,
								enabled: match?.enabled ?? false,
							}
						})

			return {
				rule: {
					...toAlertRuleRow(rule),
					excludeServiceNames: [...rule.excludeServiceNames],
					groupBy: rule.groupBy ? [...rule.groupBy] : null,
					minimumSampleCount: rule.minimumSampleCount,
					noDataBehavior: rule.noDataBehavior,
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
					...(destinations === undefined ? undefined : { destinations }),
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
					["When No Data", noDataLabel(rule.noDataBehavior)],
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
				rule.destinationIds.length === 0
					? doc.text("No notification destinations configured.")
					: rule.destinations === undefined
						? doc.text(`Destination IDs: ${rule.destinationIds.join(", ")}`)
						: doc.table(
								["Destination", "Type", "Enabled", "ID"],
								rule.destinations.map((d) => [
									d.name ?? "(deleted destination)",
									d.type ?? "-",
									d.name === null ? "-" : d.enabled ? "Yes" : "No",
									d.id,
								]),
							),
			)

			if (rule.notificationTitle || rule.notificationBody) {
				blocks.push(doc.heading("Message Template"))
				if (rule.notificationTitle) blocks.push(doc.fields([["Title", rule.notificationTitle]]))
				if (rule.notificationBody) blocks.push(doc.text("Body:"), doc.code("", rule.notificationBody))
			}

			const warnings = ruleConfigWarnings(rule)
			return {
				title: `Alert Rule: ${rule.name}`,
				...(warnings.length > 0 ? { notices: warnings } : undefined),
				blocks,
				next: [
					doc.next(
						"list_alert_checks",
						{ rule_id: rule.id },
						"recent evaluations: observed values and near-misses",
					),
					doc.next("get_incident_timeline", { rule_id: rule.id }, "incident history for this rule"),
					doc.next(
						"preview_alert_rule",
						{ rule_id: rule.id },
						"replay it over past data, with or without changes",
					),
				],
			}
		},
	})
}
