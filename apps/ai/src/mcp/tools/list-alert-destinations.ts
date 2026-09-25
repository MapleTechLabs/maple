import type { McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema } from "effect"
import { ListAlertDestinationsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { ALERT_DESTINATION_TYPES } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerListAlertDestinationsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_destinations",
		description:
			"List the notification destinations a rule can deliver to, with id, type and delivery health. Pass the ids as destination_ids to create_alert_rule / update_alert_rule.",
		parameters: Schema.Struct({
			type: P.optionalOneOf(ALERT_DESTINATION_TYPES, "Only destinations of this type"),
			enabled_only: P.optionalFlag("Only enabled destinations"),
		}),
		output: ListAlertDestinationsOutput,
		hints: { readOnly: true },
		phrases: ["Listing alert destinations", "Checking alert destinations"],
		handler: Effect.fn("McpTool.listAlertDestinations")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertsService

			const result = yield* alerts
				.listDestinations(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_alert_destinations")))

			const destinations = result.destinations.filter(
				(d) =>
					(params.type === undefined || d.type === params.type) &&
					(params.enabled_only !== true || d.enabled),
			)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				destinationType: params.type ?? "all",
				"result.rowCount": destinations.length,
			})

			return {
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
				...(params.type === undefined ? undefined : { type: params.type }),
				...(params.enabled_only === undefined ? undefined : { enabledOnly: params.enabled_only }),
			}
		}),
		render: (output) => ({
			title: "Alert Destinations",
			scope: [
				["Type", output.type],
				["Enabled only", output.enabledOnly === true ? "yes" : undefined],
			],
			...(output.destinations.length === 0
				? { empty: { message: "No alert destinations found. Add one in Alerts > Destinations." } }
				: undefined),
			blocks:
				output.destinations.length === 0
					? []
					: [
							doc.text(`Total: ${output.total} destination${output.total !== 1 ? "s" : ""}`),
							doc.table(
								["ID", "Name", "Type", "Target", "Enabled", "Last error"],
								output.destinations.map((d) => [
									d.id,
									d.name,
									d.type,
									d.channelLabel ?? d.summary,
									d.enabled ? "Yes" : d.disabledReason ? `No (${d.disabledReason})` : "No",
									d.lastTestError ?? "-",
								]),
							),
						],
			next: [
				doc.next(
					"list_alert_rules",
					{},
					"see which destinations each rule uses; route a rule with update_alert_rule destination_ids (replaces its current list)",
				),
			],
		}),
	})
}
