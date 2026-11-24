import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema } from "effect"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { auditAttribution } from "@maple/backend/services/audit/audit-access"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { CurrentMcpTenant } from "../tenant"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerResolveAlertIncidentTool(server: McpToolRegistrar) {
	server.define({
		name: "resolve_alert_incident",
		title: "Resolve Alert Incident",
		description:
			"Resolve an open alert incident by hand. Every destination it notified gets the all-clear. " +
			"If its rule still breaches, no new incident opens for that group until one healthy check has been seen, so the resolve is not undone a minute later. " +
			"To keep an incident open but quiet, use acknowledge_alert_incident or a silence instead. Only open incidents; ids from list_alert_incidents.",
		parameters: Schema.Struct({
			incident_id: P.resourceId("alertIncident", "Alert incident ID"),
		}),
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Resolving an alert incident"],
		handler: Effect.fn("McpTool.resolveAlertIncident")(function* (params) {
			const incidentId = yield* P.decodeResourceId("alertIncident", "incident_id")(params.incident_id)
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertsService
			// Attributed as the audit log attributes this call: Maple itself and a chat connector's
			// placeholder carry no user, an agent is named by its client.
			const credential = yield* CurrentAuditActor
			const attribution = auditAttribution(tenant, credential)
			const incident = yield* alerts
				.resolveIncident(tenant.orgId, incidentId, {
					userId: attribution.actor.userId ?? null,
					name: attribution.actor.label ?? (attribution.actor.type === "system" ? "Maple" : null),
					source: "mcp",
				})
				.pipe(
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
								new McpInvalidInputError({
									message: error.message,
									parameter: "incident_id",
								}),
							),
						"@maple/http/errors/AlertPersistenceError": (error) =>
							Effect.fail(toMcpHttpError("resolve_alert_incident")(error)),
					}),
				)
			return {
				id: incident.id,
				ruleId: incident.ruleId,
				ruleName: incident.ruleName,
				status: incident.status,
				resolvedAt: incident.resolvedAt,
			}
		}),
		render: (output) => ({
			title: "Incident Resolved",
			blocks: [
				doc.text(
					"Resolved by hand. Its rule opens no new incident for this group until one healthy check has been seen.",
				),
				doc.fields([
					["Incident", output.id],
					["Rule", output.ruleName],
					["Status", output.status],
					["Resolved at", output.resolvedAt ?? undefined],
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
