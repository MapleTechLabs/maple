import { McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { GetIncidentTimelineOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { ALERT_INCIDENT_STATUSES, ALERT_SEVERITIES, formatCondition, parseRuleId } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

const MAX_LIMIT = 200
/** Severity and group key filter in memory, so a filtered call reads this many rows first. */
const FILTERED_SCAN = 500

function formatTimestamp(iso: string | null): string | undefined {
	if (!iso) return undefined
	return iso.slice(0, 19).replace("T", " ")
}

export function registerGetIncidentTimelineTool(server: McpToolRegistrar) {
	server.define({
		name: "get_incident_timeline",
		description:
			"Get detailed incident timeline showing when alerts triggered, their observed values, and resolution status. Use after list_alert_incidents to get deeper details about specific incidents.",
		parameters: Schema.Struct({
			rule_id: P.optionalText(
				"Alert rule ID to filter incidents for (use list_alert_rules to find IDs)",
			),
			status: P.optionalOneOf(ALERT_INCIDENT_STATUSES, "Only incidents in this status"),
			severity: P.optionalOneOf(ALERT_SEVERITIES, "Only incidents with this severity"),
			group_key: P.optionalText("Filter by exact group key"),
			limit: P.limit({ default: 20, max: MAX_LIMIT, noun: "incidents" }),
		}),
		output: GetIncidentTimelineOutput,
		hints: { readOnly: true },
		phrases: ["Loading the incident timeline", "Building the incident timeline"],
		handler: Effect.fn("McpTool.getIncidentTimeline")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const readModels = yield* AlertReadModelsService

			const ruleId = params.rule_id === undefined ? undefined : yield* parseRuleId(params.rule_id)
			const inMemoryFilter = params.severity !== undefined || params.group_key !== undefined
			const result = yield* readModels
				.listIncidents(tenant.orgId, {
					...(ruleId === undefined ? undefined : { ruleId }),
					...(params.status === undefined ? undefined : { status: params.status }),
					limit: inMemoryFilter ? FILTERED_SCAN : params.limit + 1,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "get_incident_timeline",
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

			return {
				incidents: incidents.map((i) => ({
					id: i.id,
					ruleId: i.ruleId,
					ruleName: i.ruleName,
					groupKey: i.groupKey,
					signalType: i.signalType,
					severity: i.severity,
					status: i.status,
					comparator: i.comparator,
					threshold: i.threshold,
					lastObservedValue: i.lastObservedValue,
					firstTriggeredAt: i.firstTriggeredAt,
					lastTriggeredAt: i.lastTriggeredAt,
					resolvedAt: i.resolvedAt,
					lastNotifiedAt: i.lastNotifiedAt,
				})),
				total: incidents.length,
				openCount: incidents.filter((i) => i.status === "open").length,
				resolvedCount: incidents.filter((i) => i.status === "resolved").length,
				...(params.rule_id === undefined ? undefined : { ruleId: params.rule_id }),
				...(params.status === undefined ? undefined : { status: params.status }),
				...(params.severity === undefined ? undefined : { severity: params.severity }),
				...(params.group_key === undefined ? undefined : { groupKey: params.group_key }),
				limit: params.limit,
				hasMore: matching.length > params.limit,
			}
		}),
		render: (output) => {
			const blocks: Array<DocBlock> = []
			if (output.incidents.length > 0) {
				blocks.push(
					doc.text(
						`Total: ${output.total} (${output.openCount} open, ${output.resolvedCount} resolved)`,
					),
				)
			}
			for (const inc of output.incidents) {
				blocks.push(
					doc.heading(`${inc.ruleName} (${inc.status})`),
					doc.fields([
						["Status", inc.status],
						["Severity", inc.severity],
						["Signal type", inc.signalType],
						["Group", inc.groupKey ?? undefined],
						["Condition", `value ${formatCondition(inc)}`],
						[
							"Last observed value",
							inc.lastObservedValue != null ? String(inc.lastObservedValue) : "-",
						],
						["First triggered", formatTimestamp(inc.firstTriggeredAt)],
						["Last triggered", formatTimestamp(inc.lastTriggeredAt)],
						["Resolved at", formatTimestamp(inc.resolvedAt)],
						["Last notified", formatTimestamp(inc.lastNotifiedAt)],
						["Incident ID", inc.id],
						["Rule ID", inc.ruleId],
					]),
				)
			}

			const open = output.incidents.filter((inc) => inc.status === "open")
			const openGroups = [
				...new Set(open.flatMap((inc) => (inc.groupKey ? [inc.groupKey] : []))),
			].slice(0, 3)
			const limit = output.limit ?? 0
			return {
				title: "Incident Timeline",
				scope: [
					["Rule", output.ruleId],
					["Status", output.status],
					["Severity", output.severity],
					["Group", output.groupKey],
				],
				...(output.incidents.length === 0
					? {
							empty: {
								message: "No incidents found matching the given filters.",
								hints: ["Drop the rule_id, status, severity or group_key filter."],
							},
						}
					: undefined),
				blocks,
				...(output.hasMore === true
					? {
							truncation: {
								shown: output.incidents.length,
								noun: "incidents",
								...(limit < MAX_LIMIT
									? {
											next: doc.next(
												"get_incident_timeline",
												{
													rule_id: output.ruleId,
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
					...openGroups.map((groupKey) =>
						doc.next(
							"list_alert_incidents",
							{ group_key: groupKey },
							"see related alert incidents",
						),
					),
					...(open.length > 0
						? [doc.next("find_errors", {}, "search for recent errors related to open incidents")]
						: []),
					...(open.length === 0
						? [doc.next("list_alert_rules", {}, "review alert configuration")]
						: []),
				],
			}
		},
	})
}
