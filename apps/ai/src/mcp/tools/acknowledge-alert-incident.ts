import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { AcknowledgeAlertIncidentOutput } from "@maple/domain/mcp-outputs"
import { AlertIncidentAckService } from "@maple/backend/services/alerts/AlertIncidentAckService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { ackLabel } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerAcknowledgeAlertIncidentTool(server: McpToolRegistrar) {
	server.define({
		name: "acknowledge_alert_incident",
		title: "Acknowledge Alert Incident",
		description:
			"Mark an open alert incident as acknowledged (someone is on it) or, with acknowledged=false, clear the acknowledgement. " +
			"While acknowledged, reminders pause; an escalation to a higher severity still notifies and clears it. " +
			"Only open incidents; ids from list_alert_incidents.",
		parameters: Schema.Struct({
			incident_id: P.resourceId("alertIncident", "Alert incident ID"),
			acknowledged: P.optionalFlag("false to unacknowledge. Default true."),
		}),
		output: AcknowledgeAlertIncidentOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Acknowledging an alert incident"],
		handler: Effect.fn("McpTool.acknowledgeAlertIncident")(function* (params) {
			const incidentId = yield* P.decodeResourceId("alertIncident", "incident_id")(params.incident_id)
			const tenant = yield* CurrentMcpTenant
			const acks = yield* AlertIncidentAckService
			const acknowledge = params.acknowledged !== false
			const actor = { userId: tenant.userId, name: null, source: "mcp" as const }

			const result = yield* (
				acknowledge
					? acks.acknowledge(tenant.orgId, incidentId, actor)
					: acks.unacknowledge(tenant.orgId, incidentId, actor)
			).pipe(
				Effect.catchTags({
					"@maple/http/errors/AlertIncidentNotFoundError": () =>
						Effect.fail(
							new McpInvalidInputError({
								message: `No alert incident ${params.incident_id}. List incidents with list_alert_incidents.`,
								parameter: "incident_id",
							}),
						),
					"@maple/http/errors/AlertIncidentResolvedError": (error) =>
						Effect.fail(
							new McpInvalidInputError({ message: error.message, parameter: "incident_id" }),
						),
					"@maple/http/errors/AlertPersistenceError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}`,
								pipeName: "acknowledge_alert_incident",
								cause: error,
							}),
						),
				}),
			)

			const { incident } = result
			return {
				id: incident.id,
				ruleId: incident.ruleId,
				ruleName: incident.ruleName,
				status: incident.status,
				acknowledged: incident.acknowledgedAt !== null,
				acknowledgedAt: incident.acknowledgedAt,
				acknowledgedBy: ackLabel(incident),
				changed: result.changed,
			}
		}),
		render: (output) => ({
			title: output.acknowledged ? "Incident Acknowledged" : "Incident Unacknowledged",
			blocks: [
				...(output.changed
					? []
					: [
							doc.text(
								`Already ${output.acknowledged ? "acknowledged" : "unacknowledged"}; nothing changed.`,
							),
						]),
				doc.fields([
					["Incident", output.id],
					["Rule", output.ruleName],
					["Status", output.status],
					["Acknowledged by", output.acknowledgedBy ?? undefined],
					["Acknowledged at", output.acknowledgedAt ?? undefined],
				]),
			],
			next: [
				doc.next(
					"get_incident_timeline",
					{ rule_id: output.ruleId },
					"this rule's incident timeline",
				),
			],
		}),
	})
}
