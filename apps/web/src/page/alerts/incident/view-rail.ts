import { pluralize } from "@maple/ui/lib/format"
import { type AlertIncidentDocument, type AlertRuleDocument, isManagedSignalType } from "@maple/domain/http"
import type { V2AlertIncidentEscalation } from "@maple/domain/http/v2"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { conditionPhrase, incidentGroup, signalTitle } from "@maple/web-data/alerts/incident-timeline"
import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { statusDot } from "@maple/views/ui/status-dot"
import { createHref, incidentHref, ruleHref } from "../shared/links"
import { routingTabHref, runView } from "../shared/escalation-chains"
import { textLink } from "@maple/views/ui/text-link"
import type { Tone } from "@maple/ui/lib/tone"
import { isoMs } from "../shared/time"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"

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
			hstack(h, { gap: "2", justify: "between" }, [
				eyebrow(h, { as: "h2" }, title),
				...(action === null ? [] : [action]),
			]),
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
	const breaching = Arr.filter(rows, (row) => row.last_status === "breached").length
	const openByGroup = new Map(Arr.map(openIncidents, (open) => [open.groupKey, open]))
	return railSection(h, [`Groups · ${breaching} of ${rows.length} breaching`], null, [
		h.ul(
			[h.Class("space-y-2")],
			Arr.map(rows.slice(0, GROUP_ROW_LIMIT), (row) => {
				const breached = row.last_status === "breached"
				const open = openByGroup.get(row.group_key)
				const current = row.group_key === incident.groupKey
				return h.li(
					[h.Key(row.group_key), h.Class("flex items-center gap-2 text-sm")],
					[
						statusDot(h, {
							tone: breached ? "crit" : row.last_status == null ? "neutral" : "ok",
						}),
						open != null && !current
							? h.a(
									[
										h.Href(incidentHref(open.id)),
										h.Class("min-w-0 flex-1 truncate hover:underline active:underline"),
									],
									[row.group_key],
								)
							: h.span(
									[
										h.Class(
											cn(
												typographyClass({
													truncate: true,
													className: "min-w-0 flex-1",
												}),
												current && "font-medium",
											),
										),
									],
									[row.group_key],
								),
						h.span(
							[
								h.Class(
									cn(
										typographyClass({ size: "xs", mono: true, numeric: true }),
										breached ? "text-severity-error" : "text-muted-foreground",
									),
								),
							],
							[formatSignalValue(rule.signalType, row.last_value)],
						),
					],
				)
			}),
		),
		...(rows.length > GROUP_ROW_LIMIT
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						String(rows.length - GROUP_ROW_LIMIT),
						" more groups",
					]),
				]
			: []),
	])
}

const evidenceLink = <M>(h: HtmlBuilder<M>, detail: string, link: Html): Html =>
	h.li([h.Class("space-y-0.5")], [link, typography(h, { size: "xs", tone: "muted", as: "p" }, [detail])])

const incidentServices = (
	rule: AlertRuleDocument | null,
	incident: AlertIncidentDocument,
): ReadonlyArray<string> => {
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
	const range = {
		startTime: formatWarehouseDateTime(window.start),
		endTime: formatWarehouseDateTime(window.end),
	}
	const scope = services.length > 0 ? Arr.join(services, ", ") : "all services"
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
										h.Href(
											hrefOf(
												AppRoute.ErrorIssue({
													issueId: incident.errorIssueId,
													search: {},
												}),
											),
										),
										h.Class("hover:underline active:underline"),
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
							h.Class("hover:underline active:underline"),
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
							h.Class("hover:underline active:underline"),
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
	const recent = Arr.filter(ruleIncidents, (i) => now - isoMs(i.firstTriggeredAt) <= 30 * DAY_MS)
	const durations = Arr.flatMap(recent, (i) =>
		i.resolvedAt != null ? [isoMs(i.resolvedAt) - isoMs(i.firstTriggeredAt)] : [],
	).sort((a, b) => a - b)
	const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : undefined
	const scope = Arr.filter(
		[
			rule.groupBy != null && rule.groupBy.length > 0
				? `split by ${Arr.join(rule.groupBy, ", ")}`
				: null,
			rule.environments.length > 0 ? Arr.join(rule.environments, ", ") : null,
		],
		(part) => part != null,
	)
	const breaches = rule.consecutiveBreachesRequired
	const summary = `${signalTitle(rule.signalType)} ${conditionPhrase(rule)} over ${rule.windowMinutes}m, ${breaches} ${breaches === 1 ? "check" : "checks in a row"} to open${scope.length > 0 ? `, ${Arr.join(scope, ", ")}` : ""}.`
	// A monitor's or SLO's rule is edited through its owner, so it keeps only the history.
	const isManaged = isManagedSignalType(rule.signalType)
	return railSection(
		h,
		["Rule"],
		isManaged
			? null
			: h.a(
					[
						h.Href(createHref({ ruleId: rule.id })),
						h.Class(
							typographyClass({
								size: "xs",
								tone: "primary",
								className: "hover:underline active:underline",
							}),
						),
					],
					["Edit rule"],
				),
		[
			h.div(
				[h.Class("space-y-2")],
				[
					...(isManaged
						? []
						: [
								h.a(
									[
										h.Href(ruleHref(rule.id)),
										h.Class("block text-sm hover:underline active:underline"),
									],
									[rule.name],
								),
								typography(
									h,
									{ size: "xs", tone: "muted", as: "p", className: "leading-relaxed" },
									[summary],
								),
							]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"Fired ",
						String(recent.length),
						" ",
						pluralize(recent.length, "time"),
						" in 30d",
						median != null ? ` · median ${Math.max(1, Math.round(median / 60_000))}m` : "",
					]),
				],
			),
		],
	)
}

const RUN_TONE = { escalating: "warn", paused: "neutral", finished: "neutral" } as const satisfies Record<
	ReturnType<typeof runView>["state"],
	Tone
>

/** `EscalationSection`: the chain paging this incident, where it stands, and when it pages next. */
export const escalationSection = <M>(
	h: HtmlBuilder<M>,
	run: V2AlertIncidentEscalation,
	incident: AlertIncidentDocument,
	timeZone: string,
	now: number,
): Html => {
	const view = runView(run, incident.acknowledgedAt !== null, timeZone, now)
	return railSection(
		h,
		["Escalation"],
		textLink(h, { href: routingTabHref(), tone: "muted", className: "text-xs" }, ["View chains"]),
		[
			vstack(h, { gap: "1.5" }, [
				hstack(h, { gap: "2" }, [
					statusDot(h, { tone: RUN_TONE[view.state] }),
					typography(h, { size: "sm", weight: "medium" }, [view.label]),
				]),
				typography(
					h,
					{ size: "sm", truncate: true, as: "p", attributes: [h.Title(run.chain_name)] },
					[run.chain_name],
				),
				typography(h, { size: "xs", tone: "muted", as: "p", numeric: true }, [view.detail]),
				typography(h, { size: "xs", tone: "muted", as: "p", numeric: true }, [
					String(run.steps_sent),
					" ",
					pluralize(run.steps_sent, "step"),
					view.state === "finished" ? " paged" : " paged so far",
				]),
			]),
		],
	)
}

export type EscalationData = AsyncData.AsyncData<V2AlertIncidentEscalation | null, unknown>

const escalationNote = <M>(h: HtmlBuilder<M>, text: string): Html =>
	railSection(h, ["Escalation"], null, [typography(h, { size: "xs", tone: "muted", as: "p" }, [text])])

/** The run once read, a note while it loads or after it failed, nothing for an incident without one. */
const escalationBlock = <M>(
	h: HtmlBuilder<M>,
	escalation: EscalationData,
	incident: AlertIncidentDocument,
	timeZone: string,
	now: number,
): ReadonlyArray<Html> =>
	Option.match(AsyncData.getData(escalation), {
		onSome: (run) => (run === null ? [] : [escalationSection(h, run, incident, timeZone, now)]),
		onNone: () => [
			escalationNote(
				h,
				AsyncData.isFailure(escalation) ? "Couldn't load the escalation." : "Loading the escalation…",
			),
		],
	})

export const incidentRail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		rule: AlertRuleDocument | null
		incident: AlertIncidentDocument
		states: ReadonlyArray<AlertRuleStateRow>
		ruleIncidents: ReadonlyArray<AlertIncidentDocument>
		window: Readonly<{ start: number; end: number }>
		now: number
		escalation: EscalationData
		timeZone: string
	}>,
): Html => {
	const { rule, incident, states } = options
	const isGrouped = rule != null && rule.groupBy != null && rule.groupBy.length > 0 && states.length > 1
	return h.aside(
		[h.Class("space-y-5 lg:border-l lg:pl-6")],
		[
			...escalationBlock(h, options.escalation, incident, options.timeZone, options.now),
			...(isGrouped && rule !== null
				? [
						groupsSection(
							h,
							rule,
							incident,
							states,
							Arr.filter(options.ruleIncidents, (i) => i.status === "open"),
						),
					]
				: []),
			evidenceSection(h, rule, incident, options.window),
			...(rule !== null ? [ruleSection(h, rule, options.ruleIncidents, options.now)] : []),
		],
	)
}
