import { McpQueryError, type McpToolRegistrar } from "./types"
import { toMcpHttpError } from "../lib/map-http-error"
import { Effect, Schema, Array as Arr } from "effect"
import { encodePublicId, PublicIdPrefixes, scopeAllows } from "@maple/domain/http/v2"
import type { OrgId } from "@maple/primitives"
import { CurrentMcpTenant } from "../tenant"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { SlosService } from "@maple/backend/services/slos/SlosService"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { ALERT_DESTINATION_TYPES } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "list_alert_destinations"

const unavailable = (error: { readonly message: string }) =>
	new McpQueryError({ message: error.message, pipeName: TOOL, cause: error })

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Routing a scoped key reads only with a scope of its own, as the list tool of each requires. */
const SCOPED_USERS = [
	{ family: "uptime_monitors", label: "uptime monitors" },
	{ family: "slos", label: "SLOs" },
] as const

/**
 * What routes to each destination, so "is it still used" is this one call. Rules and chains are
 * named; monitors and SLOs are counted, and left out for a key that cannot read them.
 */
const destinationUsers = Effect.fnUntraced(function* (
	orgId: OrgId,
	scopes: ReadonlyArray<string> | null | undefined,
) {
	const readable = (family: string) => scopeAllows(scopes, { family, access: "read" })
	const [rules, chains, policy, monitors, slos] = yield* Effect.all(
		[
			AlertRulesService.pipe(
				Effect.flatMap((service) => service.listRules(orgId)),
				Effect.mapError(toMcpHttpError(TOOL)),
			),
			EscalationChainsService.pipe(
				Effect.flatMap((service) => service.list(orgId)),
				Effect.mapError(toMcpHttpError(TOOL)),
			),
			ErrorPolicyService.pipe(
				Effect.flatMap((service) => service.getNotificationPolicy(orgId)),
				Effect.mapError(unavailable),
			),
			readable("uptime_monitors")
				? UptimeMonitorsService.pipe(
						Effect.flatMap((service) => service.list(orgId)),
						Effect.mapError(unavailable),
					)
				: Effect.succeed([]),
			readable("slos")
				? SlosService.pipe(
						Effect.flatMap((service) => service.list(orgId)),
						Effect.mapError(unavailable),
					)
				: Effect.succeed([]),
		],
		{ concurrency: 5 },
	)
	const notChecked = Arr.flatMap(SCOPED_USERS, (user) => (readable(user.family) ? [] : [user.label]))
	const usedBy = (destinationId: string): ReadonlyArray<string> => {
		const names = (id: string) => id === destinationId
		const monitorCount = Arr.filter(monitors, (monitor) => Arr.some(monitor.destinationIds, names)).length
		const sloCount = Arr.filter(
			slos,
			(slo) =>
				Arr.some(slo.alerting.criticalDestinationIds, names) ||
				Arr.some(slo.alerting.warningDestinationIds, names),
		).length
		return [
			...Arr.flatMap(rules.rules, (rule) =>
				Arr.some(rule.destinationIds, names) ? [`rule "${rule.name}"`] : [],
			),
			...Arr.flatMap(chains.chains, (chain) =>
				Arr.some(chain.steps, (step) =>
					Arr.some(
						step.targets,
						(target) => target.type === "destination" && target.destinationId === destinationId,
					),
				)
					? [`escalation chain "${chain.name}"`]
					: [],
			),
			...(Arr.some(policy.destinationIds, names) ? ["error notifications"] : []),
			...(monitorCount === 0 ? [] : [plural(monitorCount, "uptime monitor")]),
			...(sloCount === 0 ? [] : [plural(sloCount, "SLO")]),
		]
	}
	return { usedBy, notChecked }
})

export function registerListAlertDestinationsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_destinations",
		title: "List Alert Destinations",
		description:
			"List the notification destinations a rule can deliver to, with id, type, delivery health and what routes to each (alert rules, escalation chains, error notifications, uptime monitors, SLOs). One that nothing uses can be deleted without further checks. Pass the ids as destination_ids to create_alert_rule / update_alert_rule.",
		parameters: Schema.Struct({
			type: P.optionalOneOf(ALERT_DESTINATION_TYPES, "Only destinations of this type"),
			enabled_only: P.optionalFlag("Only enabled destinations"),
		}),
		hints: { readOnly: true },
		permission: "telemetry:read",
		phrases: ["Listing alert destinations", "Checking alert destinations"],
		handler: Effect.fn("McpTool.listAlertDestinations")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const destinationsService = yield* AlertDestinationsService

			const result = yield* destinationsService
				.listDestinations(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_alert_destinations")))
			const users = yield* destinationUsers(tenant.orgId, tenant.scopes)

			const destinations = Arr.filter(
				result.destinations,
				(d) =>
					(params.type === undefined || d.type === params.type) &&
					(params.enabled_only !== true || d.enabled),
			)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.destination_type": params.type ?? "all",
				"result.rowCount": destinations.length,
			})

			return {
				destinations: Arr.map(destinations, (d) => ({
					id: d.id,
					publicId: encodePublicId(PublicIdPrefixes.alertDestination, d.id),
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
					usedBy: users.usedBy(d.id),
				})),
				total: destinations.length,
				...(users.notChecked.length === 0 ? undefined : { usageNotChecked: users.notChecked }),
				...(params.type === undefined ? undefined : { type: params.type }),
				...(params.enabled_only === undefined ? undefined : { enabledOnly: params.enabled_only }),
			}
		}),
		render: (output) => ({
			title: "Alert Destinations",
			notices:
				output.usageNotChecked === undefined
					? []
					: [
							`"Used by" leaves out ${Arr.join(output.usageNotChecked, " and ")}: this API key cannot read them, so a destination shown as unused may still receive their alerts.`,
						],
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
								[
									"ID",
									"REST id",
									"Name",
									"Type",
									"Target",
									"Enabled",
									"Used by",
									"Last error",
								],
								Arr.map(output.destinations, (d) => [
									d.id,
									d.publicId,
									d.name,
									d.type,
									d.channelLabel ?? d.summary,
									d.enabled ? "Yes" : d.disabledReason ? `No (${d.disabledReason})` : "No",
									d.usedBy === undefined || d.usedBy.length === 0
										? "nothing"
										: Arr.join(d.usedBy, ", "),
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
