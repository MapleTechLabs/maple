import { optionalBooleanParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { formatTable } from "../lib/format"
import { toMcpHttpError } from "../lib/map-http-error"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"

export function registerListAlertDestinationsTool(server: McpToolRegistrar) {
	server.tool(
		"list_alert_destinations",
		"List the notification destinations alert rules can deliver to (Slack, Discord, PagerDuty, webhook, email, …) with their IDs, type, and delivery health. Pass these IDs as destination_ids to create_alert_rule / update_alert_rule.",
		Schema.Struct({
			type: optionalStringParam(
				"Filter by destination type: slack-bot, pagerduty, webhook, hazel-oauth, discord, telegram, email, chat",
			),
			enabled_only: optionalBooleanParam("Only return enabled destinations (default: false)"),
		}),
		Effect.fn("McpTool.listAlertDestinations")(function* ({ type, enabled_only }) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertsService

			const result = yield* alerts
				.listDestinations(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_alert_destinations")))

			let destinations = result.destinations
			if (type) {
				destinations = destinations.filter((d) => d.type === type)
			}
			if (enabled_only) {
				destinations = destinations.filter((d) => d.enabled)
			}

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				destinationType: type ?? "all",
				"result.rowCount": destinations.length,
			})

			const lines: string[] = [
				`## Alert Destinations`,
				`Total: ${destinations.length} destination${destinations.length !== 1 ? "s" : ""}`,
				``,
			]

			if (destinations.length === 0) {
				lines.push("No alert destinations found. Add one in Alerts → Destinations.")
			} else {
				const headers = ["ID", "Name", "Type", "Target", "Enabled", "Last error"]
				const rows = destinations.map((d) => [
					d.id,
					d.name,
					d.type,
					d.channelLabel ?? d.summary,
					d.enabled ? "Yes" : d.disabledReason ? `No (${d.disabledReason})` : "No",
					d.lastTestError ?? "—",
				])
				lines.push(formatTable(headers, rows))
			}

			lines.push(
				formatNextSteps([
					'`update_alert_rule rule_id="<id>" destination_ids="<ids>"` — route a rule to these destinations (replaces its current list)',
					"`list_alert_rules` — see which destinations each rule uses",
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_alert_destinations",
					data: {
						destinations: destinations.map((d) => ({
							id: d.id,
							name: d.name,
							type: d.type,
							enabled: d.enabled,
							summary: d.summary,
							channelLabel: d.channelLabel,
							lastTestedAt: d.lastTestedAt,
							lastTestError: d.lastTestError,
							disabledReason: d.disabledReason ?? null,
							createdAt: d.createdAt,
							updatedAt: d.updatedAt,
						})),
						total: destinations.length,
					},
				}),
			}
		}),
		{ phrases: ["Listing alert destinations", "Checking alert destinations"] },
	)
}
