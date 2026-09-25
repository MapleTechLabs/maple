import type { McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema } from "effect"
import { ListAlertRulesOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { ALERT_SEVERITIES, ALERT_SIGNAL_TYPES, formatCondition, toAlertRuleRow } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerListAlertRulesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_rules",
		description:
			"List configured alert rules with severity, signal type and condition. Use list_alert_incidents for what has fired.",
		parameters: Schema.Struct({
			services: P.optionalList("Only rules scoped to any of these services"),
			signal_type: P.optionalOneOf(ALERT_SIGNAL_TYPES, "Only rules on this signal type"),
			severity: P.optionalOneOf(ALERT_SEVERITIES, "Only rules with this severity"),
			enabled_only: P.optionalFlag("Only enabled rules"),
		}),
		aliases: { service_names: "services" },
		output: ListAlertRulesOutput,
		hints: { readOnly: true },
		phrases: ["Listing alert rules", "Checking alert rules"],
		handler: Effect.fn("McpTool.listAlertRules")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertRulesService

			const result = yield* alerts
				.listRules(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_alert_rules")))

			const services =
				params.services !== undefined && params.services.length > 0 ? params.services : undefined
			const rules = result.rules.filter(
				(r) =>
					(services === undefined ||
						services.some((service) => r.serviceNames.includes(service))) &&
					(params.signal_type === undefined || r.signalType === params.signal_type) &&
					(params.severity === undefined || r.severity === params.severity) &&
					(params.enabled_only !== true || r.enabled),
			)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				signalType: params.signal_type ?? "all",
				severity: params.severity ?? "all",
				"result.rowCount": rules.length,
			})

			return {
				rules: rules.map(toAlertRuleRow),
				total: rules.length,
				...(services === undefined ? undefined : { services: [...services] }),
				...(params.signal_type === undefined ? undefined : { signalType: params.signal_type }),
				...(params.severity === undefined ? undefined : { severity: params.severity }),
				...(params.enabled_only === undefined ? undefined : { enabledOnly: params.enabled_only }),
			}
		}),
		render: (output) => ({
			title: "Alert Rules",
			scope: [
				["Services", output.services?.join(", ")],
				["Signal", output.signalType],
				["Severity", output.severity],
				["Enabled only", output.enabledOnly === true ? "yes" : undefined],
			],
			...(output.rules.length === 0
				? {
						empty: {
							message: "No alert rules found.",
							hints: [
								"Drop the filters to see every rule, or create one with create_alert_rule.",
							],
						},
					}
				: undefined),
			blocks:
				output.rules.length === 0
					? []
					: [
							doc.text(`Total: ${output.total} rule${output.total !== 1 ? "s" : ""}`),
							doc.table(
								["ID", "Name", "Severity", "Signal", "Condition", "Enabled", "Destinations"],
								output.rules.map((r) => [
									r.id,
									r.name,
									r.severity,
									r.signalType,
									formatCondition(r),
									r.enabled ? "Yes" : "No",
									String(r.destinationIds.length),
								]),
							),
						],
			next: [
				...output.rules
					.slice(0, 1)
					.map((r) =>
						doc.next("get_alert_rule", { rule_id: r.id }, `full configuration of "${r.name}"`),
					),
				doc.next("list_alert_incidents", {}, "see triggered alerts"),
				doc.next(
					"list_alert_destinations",
					{},
					'find destination IDs, then create_alert_rule template="high_error_rate" for a new rule',
				),
			],
		}),
	})
}
