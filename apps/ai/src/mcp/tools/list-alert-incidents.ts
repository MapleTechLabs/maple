import { McpQueryError, type McpToolRegistrar } from "./types"
import { truncate } from "../lib/format"
import { Clock, Effect, Schema } from "effect"
import { ListAlertIncidentsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { ALERT_INCIDENT_STATUSES, ALERT_SEVERITIES, formatCondition } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const MAX_LIMIT = 200
/** Severity and group key filter in memory, so a filtered call reads this many rows first. */
const FILTERED_SCAN = 500
/** status=open also counts incidents resolved this recently, so a just-cleared alert is not "nothing". */
const RECENTLY_RESOLVED_HOURS = 24

export function registerListAlertIncidentsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_incidents",
		title: "List Alert Incidents",
		description:
			"List triggered alert incidents (open and resolved) with severity, group, condition and last observed value. For one rule's history with trigger, notify and resolve timestamps use get_incident_timeline.",
		parameters: Schema.Struct({
			status: P.optionalOneOf(ALERT_INCIDENT_STATUSES, "Only incidents in this status"),
			severity: P.optionalOneOf(ALERT_SEVERITIES, "Only incidents with this severity"),
			group_key: P.optionalText("Only incidents with this exact group key"),
			limit: P.limit({ default: 50, max: MAX_LIMIT, noun: "incidents" }),
		}),
		output: ListAlertIncidentsOutput,
		hints: { readOnly: true },
		phrases: ["Listing alert incidents", "Checking recent alerts"],
		handler: Effect.fn("McpTool.listAlertIncidents")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const readModels = yield* AlertReadModelsService

			const inMemoryFilter = params.severity !== undefined || params.group_key !== undefined
			const result = yield* readModels
				.listIncidents(tenant.orgId, {
					...(params.status === undefined ? undefined : { status: params.status }),
					limit: inMemoryFilter ? FILTERED_SCAN : params.limit + 1,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "list_alert_incidents",
								cause: error,
							}),
					),
				)

			const matching = result.incidents.filter(
				(i) =>
					(params.severity === undefined || i.severity === params.severity) &&
					(params.group_key === undefined || i.groupKey === params.group_key),
			)
			const incidents = matching.slice(0, params.limit)

			const openCount = incidents.filter((i) => i.status === "open").length
			const resolvedCount = incidents.filter((i) => i.status === "resolved").length

			const recentlyResolvedCount =
				params.status === "open"
					? yield* readModels.listIncidents(tenant.orgId, { status: "resolved", limit: 100 }).pipe(
							Effect.flatMap((resolved) =>
								Clock.currentTimeMillis.pipe(
									Effect.map((now) => {
										const cutoff = now - RECENTLY_RESOLVED_HOURS * 3_600_000
										return resolved.incidents.filter(
											(i) =>
												i.resolvedAt !== null &&
												Date.parse(i.resolvedAt) >= cutoff &&
												(params.severity === undefined ||
													i.severity === params.severity) &&
												(params.group_key === undefined ||
													i.groupKey === params.group_key),
										).length
									}),
								),
							),
							// A best-effort hint: failing to read it never fails the open list.
							Effect.orElseSucceed(() => undefined),
						)
					: undefined

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				status: params.status ?? "all",
				severity: params.severity ?? "all",
				"result.rowCount": incidents.length,
			})

			return {
				incidents: incidents.map((i) => ({
					id: i.id,
					ruleId: i.ruleId,
					ruleName: i.ruleName,
					groupKey: i.groupKey,
					signalType: i.signalType,
					severity: i.severity,
					status: i.status,
					holdReason: i.holdReason,
					heldSince: i.heldSince,
					threshold: i.threshold,
					comparator: i.comparator,
					firstTriggeredAt: i.firstTriggeredAt,
					resolvedAt: i.resolvedAt,
					lastObservedValue: i.lastObservedValue,
				})),
				total: incidents.length,
				openCount,
				resolvedCount,
				...(recentlyResolvedCount === undefined ? undefined : { recentlyResolvedCount }),
				...(params.status === undefined ? undefined : { status: params.status }),
				...(params.severity === undefined ? undefined : { severity: params.severity }),
				...(params.group_key === undefined ? undefined : { groupKey: params.group_key }),
				limit: params.limit,
				hasMore: matching.length > params.limit,
			}
		}),
		render: (output) => {
			const openGroups = [
				...new Set(
					output.incidents.flatMap((i) => (i.status === "open" && i.groupKey ? [i.groupKey] : [])),
				),
			].slice(0, 3)
			const limit = output.limit ?? 0
			const scanNotice =
				output.severity !== undefined || output.groupKey !== undefined
					? `severity and group_key are applied to the ${FILTERED_SCAN} most recent incidents; older matches are not returned.`
					: undefined
			const recent = output.recentlyResolvedCount ?? 0
			const recentNote =
				output.recentlyResolvedCount === undefined
					? undefined
					: `${recent} resolved in the last ${RECENTLY_RESOLVED_HOURS}h.`
			const recentNext =
				recent > 0
					? [
							doc.next(
								"list_alert_incidents",
								{ status: "resolved", severity: output.severity, group_key: output.groupKey },
								"the recently resolved incidents",
							),
						]
					: []
			return {
				title: "Alert Incidents",
				scope: [
					["Status", output.status],
					["Severity", output.severity],
					["Group", output.groupKey],
				],
				...(scanNotice === undefined ? undefined : { notices: [scanNotice] }),
				...(output.incidents.length === 0
					? {
							empty: {
								message:
									recentNote === undefined
										? "No alert incidents found."
										: `No open alert incidents. ${recentNote}`,
								hints: [
									"Drop the status, severity or group_key filter, or review rules with list_alert_rules.",
									...(scanNotice === undefined
										? []
										: [
												"Narrow with status, or use get_incident_timeline with rule_id, to reach older incidents.",
											]),
								],
							},
						}
					: undefined),
				blocks:
					output.incidents.length === 0
						? []
						: [
								doc.text(
									`Total: ${output.total} (${output.openCount} open, ${output.resolvedCount} resolved)${recentNote === undefined ? "" : `. ${recentNote}`}`,
								),
								doc.table(
									[
										"Rule",
										"Severity",
										"Status",
										"Group",
										"Signal",
										"Condition",
										"Value",
										"Triggered",
									],
									output.incidents.map((i) => [
										truncate(i.ruleName, 30),
										i.severity,
										i.holdReason != null
											? `open (waiting on data: ${i.holdReason})`
											: i.status,
										i.groupKey ?? "all",
										i.signalType,
										formatCondition(i),
										i.lastObservedValue != null ? String(i.lastObservedValue) : "-",
										i.firstTriggeredAt.slice(0, 19),
									]),
								),
							],
				...(output.hasMore === true
					? {
							truncation: {
								shown: output.incidents.length,
								noun: "incidents",
								...(limit < MAX_LIMIT
									? {
											next: doc.next(
												"list_alert_incidents",
												{
													status: output.status,
													severity: output.severity,
													group_key: output.groupKey,
													limit: MAX_LIMIT,
												},
												"more incidents",
											),
										}
									: undefined),
							},
						}
					: undefined),
				next: [
					...recentNext,
					...(openGroups.length > 0
						? openGroups.map((groupKey) =>
								doc.next(
									"get_incident_timeline",
									{ group_key: groupKey },
									"inspect this alert group",
								),
							)
						: [doc.next("list_alert_rules", {}, "review alert configuration")]),
				],
			}
		},
	})
}
