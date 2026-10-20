import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { conditionPhrase, incidentGroup, signalTitle } from "@maple/web-data/alerts/incident-timeline"
import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { eyebrow } from "../../../ui/eyebrow"
import { statusDot } from "../../../ui/status-dot"
import { createHref, incidentHref, ruleHref } from "../shared/links"
import { isoMs } from "../shared/time"

// `IncidentRail`: the incident detail's side rail.

const GROUP_ROW_LIMIT = 8
const DAY_MS = 24 * 60 * 60 * 1000

const railSection = <M>(
	h: HtmlBuilder<M>,
	title: ReadonlyArray<string>,
	action: Html | null,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.Class("space-y-3 border-b pb-5 last:border-b-0")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[eyebrow(h, { as: "h2" }, title), ...(action === null ? [] : [action])],
			),
			...children,
		],
	)

const groupsSection = <M>(
	h: HtmlBuilder<M>,
	rule: AlertRuleDocument,
	incident: AlertIncidentDocument,
	states: ReadonlyArray<AlertRuleStateRow>,
	openIncidents: ReadonlyArray<AlertIncidentDocument>,
): Html => {
	const rows = [...states].sort((a, b) => {
		const breached = Number(b.last_status === "breached") - Number(a.last_status === "breached")
		return breached !== 0 ? breached : (b.last_value ?? 0) - (a.last_value ?? 0)
	})
	const breaching = rows.filter((row) => row.last_status === "breached").length
	const openByGroup = new Map(openIncidents.map((open) => [open.groupKey, open]))
	return railSection(h, [`Groups · ${breaching} of ${rows.length} breaching`], null, [
		h.ul(
			[h.Class("space-y-2")],
			rows.slice(0, GROUP_ROW_LIMIT).map((row) => {
				const breached = row.last_status === "breached"
				const open = openByGroup.get(row.group_key)
				const current = row.group_key === incident.groupKey
				return h.li(
					[h.Key(row.group_key), h.Class("flex items-center gap-2 text-sm")],
					[
						statusDot(h, { tone: breached ? "crit" : row.last_status == null ? "neutral" : "ok" }),
						open != null && !current
							? h.a(
									[h.Href(incidentHref(open.id)), h.Class("min-w-0 flex-1 truncate hover:underline")],
									[row.group_key],
								)
							: h.span([h.Class(cn("min-w-0 flex-1 truncate", current && "font-medium"))], [row.group_key]),
						h.span(
							[
								h.Class(
									cn("font-mono text-xs tabular-nums", breached ? "text-severity-error" : "text-muted-foreground"),
								),
							],
							[formatSignalValue(rule.signalType, row.last_value)],
						),
					],
				)
			}),
		),
		...(rows.length > GROUP_ROW_LIMIT
			? [h.p([h.Class("text-muted-foreground text-xs")], [String(rows.length - GROUP_ROW_LIMIT), " more groups"])]
			: []),
	])
}

const evidenceLink = <M>(h: HtmlBuilder<M>, detail: string, link: Html): Html =>
	h.li([h.Class("space-y-0.5")], [link, h.p([h.Class("text-muted-foreground text-xs")], [detail])])

const incidentServices = (rule: AlertRuleDocument | null, incident: AlertIncidentDocument): ReadonlyArray<string> => {
	const group = incidentGroup(incident)
	if (group != null && rule?.groupBy?.length === 1 && rule.groupBy[0] === "service.name") return [group]
	return rule?.serviceNames ?? []
}

const evidenceSection = <M>(
	h: HtmlBuilder<M>,
	rule: AlertRuleDocument | null,
	incident: AlertIncidentDocument,
	window: Readonly<{ start: number; end: number }>,
): Html => {
	const services = incidentServices(rule, incident)
	const range = { startTime: formatWarehouseDateTime(window.start), endTime: formatWarehouseDateTime(window.end) }
	const scope = services.length > 0 ? services.join(", ") : "all services"
	const servicesSearch = services.length > 0 ? [...services] : undefined
	return railSection(h, ["Evidence"], null, [
		h.ul(
			[h.Class("space-y-3 text-sm")],
			[
				...(incident.errorIssueId != null
					? [
							evidenceLink(
								h,
								"The error issue behind this alert",
								h.a(
									[
										h.Href(hrefOf(AppRoute.ErrorIssue({ issueId: incident.errorIssueId, search: {} }))),
										h.Class("hover:underline"),
									],
									["Linked error issue"],
								),
							),
						]
					: []),
				evidenceLink(
					h,
					`${scope}, incident window`,
					h.a(
						[
							h.Href(
								hrefOf(
									AppRoute.Traces({
										search: {
											services: servicesSearch,
											hasError: incident.signalType === "error_rate" ? true : undefined,
											...range,
										},
									}),
								),
							),
							h.Class("hover:underline"),
						],
						[incident.signalType === "error_rate" ? "Error traces" : "Traces"],
					),
				),
				evidenceLink(
					h,
					`${scope}, incident window`,
					h.a(
						[
							h.Href(hrefOf(AppRoute.Logs({ search: { services: servicesSearch, ...range } }))),
							h.Class("hover:underline"),
						],
						["Logs"],
					),
				),
			],
		),
	])
}

const ruleSection = <M>(
	h: HtmlBuilder<M>,
	rule: AlertRuleDocument,
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>,
	now: number,
): Html => {
	const recent = ruleIncidents.filter((i) => now - isoMs(i.firstTriggeredAt) <= 30 * DAY_MS)
	const durations = recent
		.flatMap((i) => (i.resolvedAt != null ? [isoMs(i.resolvedAt) - isoMs(i.firstTriggeredAt)] : []))
		.sort((a, b) => a - b)
	const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : undefined
	const scope = [
		rule.groupBy != null && rule.groupBy.length > 0 ? `split by ${rule.groupBy.join(", ")}` : null,
		rule.environments.length > 0 ? rule.environments.join(", ") : null,
	].filter((part) => part != null)
	const breaches = rule.consecutiveBreachesRequired
	const summary = `${signalTitle(rule.signalType)} ${conditionPhrase(rule)} over ${rule.windowMinutes}m, ${breaches} ${breaches === 1 ? "check" : "checks in a row"} to open${scope.length > 0 ? `, ${scope.join(", ")}` : ""}.`
	return railSection(
		h,
		["Rule"],
		h.a([h.Href(createHref({ ruleId: rule.id })), h.Class("text-primary text-xs hover:underline")], ["Edit rule"]),
		[
			h.div(
				[h.Class("space-y-2")],
				[
					h.a([h.Href(ruleHref(rule.id)), h.Class("block text-sm hover:underline")], [rule.name]),
					h.p([h.Class("text-muted-foreground text-xs leading-relaxed")], [summary]),
					h.p(
						[h.Class("text-muted-foreground text-xs")],
						[
							"Fired ",
							String(recent.length),
							" ",
							recent.length === 1 ? "time" : "times",
							" in 30d",
							median != null ? ` · median ${Math.max(1, Math.round(median / 60_000))}m` : "",
						],
					),
				],
			),
		],
	)
}

export const incidentRail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		rule: AlertRuleDocument | null
		incident: AlertIncidentDocument
		states: ReadonlyArray<AlertRuleStateRow>
		ruleIncidents: ReadonlyArray<AlertIncidentDocument>
		window: Readonly<{ start: number; end: number }>
		now: number
	}>,
): Html => {
	const { rule, incident, states } = options
	const isGrouped = rule != null && rule.groupBy != null && rule.groupBy.length > 0 && states.length > 1
	return h.aside(
		[h.Class("space-y-5 lg:border-l lg:pl-6")],
		[
			...(isGrouped && rule !== null
				? [
						groupsSection(
							h,
							rule,
							incident,
							states,
							options.ruleIncidents.filter((i) => i.status === "open"),
						),
					]
				: []),
			evidenceSection(h, rule, incident, options.window),
			...(rule !== null ? [ruleSection(h, rule, options.ruleIncidents, options.now)] : []),
		],
	)
}
