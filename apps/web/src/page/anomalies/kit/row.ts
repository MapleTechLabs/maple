import type { AnomalyIncidentDocument, AnomalyIncidentId, ErrorIssueId } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	META_CHIP_CLASS,
	SEVERITY_TONE,
	severityToneFor,
	SIGNAL_ICON_NAME,
	SIGNAL_LABEL,
	TRIAGE_STATUS_CHIP,
} from "@maple/web-data/anomalies/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"

// `AnomalyRow`: one anomaly in a list.

/** `shortIssueId`: the first seven hex digits, upper case. */
export const shortIssueId = (id: string): string => id.replace(/-/g, "").slice(0, 7).toUpperCase()

export const anomalyHref = (incidentId: AnomalyIncidentId) => hrefOf(AppRoute.Anomaly({ incidentId }))

export type AnomalyRowOptions<M> = Readonly<{
	incident: AnomalyIncidentDocument
	nowMs: number
	timeZone: string
	isFocused?: boolean
	onHover?: M
	variant?: "default" | "compact"
}>

export const anomalyRow = <M>(h: HtmlBuilder<M>, options: AnomalyRowOptions<M>): Html => {
	const { incident } = options
	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident, options.nowMs)
	const isLive = isOpen && !isStale
	const tone = severityToneFor(incident)
	const displayTone = isStale ? SEVERITY_TONE.resolved : tone
	const dev = deviation(incident)
	const triageChip = TRIAGE_STATUS_CHIP[incident.triageStatus]
	const isCompact = options.variant === "compact"
	const activeFingerprints = incident.fingerprints.filter((f) => f.resolvedAt === null).length
	const label = SIGNAL_LABEL[incident.signalType]
	const meta = (className: string, title: string | null, children: ReadonlyArray<Html | string>) =>
		badge(
			h,
			{
				variant: "meta",
				pill: true,
				size: "sm",
				className: cn(META_CHIP_CLASS, className),
				attributes: title === null ? [] : [h.Title(title)],
			},
			children,
		)
	return h.div(
		[
			h.DataAttribute("incident-id", incident.id),
			...(options.isFocused === true ? [h.DataAttribute("focused", "true")] : []),
			...(options.onHover === undefined ? [] : [h.OnMouseEnter(options.onHover)]),
			h.Class(
				cn(
					"group/row relative flex h-9 items-center gap-2 pr-3 pl-3 text-sm",
					"hover:bg-muted/50",
					"data-focused:bg-muted/40",
					"transition-colors",
				),
			),
		],
		[
			h.a([
				h.Href(anomalyHref(incident.id)),
				h.AriaLabel(`${isLive ? "Open" : "Inspect"} ${isStale ? "stale " : ""}${label} anomaly on ${incident.serviceName}`),
				h.Class("absolute inset-0 focus-visible:outline-none"),
				h.Tabindex(-1),
			]),
			h.span([h.AriaHidden(true), h.Class(cn("absolute inset-y-0 left-0 w-px", displayTone.accent))]),
			h.span(
				[h.Class("relative z-10 flex w-3 shrink-0 items-center justify-center")],
				[
					isLive
						? statusDot(h, { tone: tone.tone, attributes: [h.Title(`Open · ${incident.severity}`)] })
						: statusDot(h, { tone: "neutral", attributes: [h.Title(isStale ? "Stale detector state" : "Resolved")] }),
				],
			),
			h.span(
				[
					h.Class(
						"relative z-10 flex min-w-0 flex-1 items-center gap-1.5 font-medium text-foreground sm:w-[130px] sm:flex-none",
					),
				],
				[
					icon(h, SIGNAL_ICON_NAME[incident.signalType], { size: 14, className: "shrink-0 text-muted-foreground" }),
					h.span([h.Class("truncate")], [label]),
				],
			),
			h.span(
				[
					h.Class(
						cn(
							"relative z-10 w-[110px] shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums",
							isLive ? tone.text : "text-muted-foreground",
						),
					),
					h.Title(
						`Observed ${formatSignalValue(incident.signalType, incident.lastObservedValue)} vs baseline ${formatSignalValue(incident.signalType, incident.baselineMedian)}`,
					),
				],
				[dev.label],
			),
			h.span(
				[
					h.Class(
						"relative z-10 hidden w-[170px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground lg:inline-block",
					),
				],
				[
					formatSignalValue(incident.signalType, incident.lastObservedValue),
					h.span([h.Class("text-muted-foreground/50")], [" ← "]),
					formatSignalValue(incident.signalType, incident.baselineMedian),
				],
			),
			...(isCompact
				? []
				: [
						meta("z-10 hidden min-w-0 shrink md:inline-flex", incident.serviceName, [
							serviceDot(h, { serviceName: incident.serviceName, size: "sm" }),
							h.span([h.Class("max-w-[140px] truncate")], [incident.serviceName]),
						]),
					]),
			h.span(
				[h.Class("relative z-10 hidden shrink-0 text-xs text-muted-foreground xl:inline-block")],
				[incident.deploymentEnv || EMPTY_VALUE],
			),
			h.span([h.Class("relative z-0 hidden min-w-0 flex-1 sm:block")]),
			...(activeFingerprints > 1
				? [
						meta("z-10 hidden sm:inline-flex", `${activeFingerprints} error fingerprints grouped into this incident`, [
							String(activeFingerprints),
							" errors",
						]),
					]
				: []),
			...(incident.reopenCount > 0
				? [
						meta("z-10 hidden sm:inline-flex", "This anomaly re-breached and reopened after resolving", [
							"reopened",
							...(incident.reopenCount > 1 ? [` ×${incident.reopenCount}`] : []),
						]),
					]
				: []),
			...(triageChip === null
				? []
				: [
						badge(
							h,
							{
								pill: true,
								size: "sm",
								className: cn(META_CHIP_CLASS, "z-10 hidden font-medium sm:inline-flex", triageChip.tone),
							},
							[triageChip.label],
						),
					]),
			...(isCompact || incident.errorIssueId === null
				? []
				: [linkedIssueChip(h, incident.errorIssueId)]),
			relativeTime(h, {
				value: isStale ? incident.lastTriggeredAt : incident.firstTriggeredAt,
				nowMs: options.nowMs,
				timeZone: options.timeZone,
				prefix: isStale ? "last seen" : undefined,
				tooltip: "title",
				className: "relative z-10 w-28 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground",
			}),
		],
	)
}

/** The linked-issue `Badge render={<Link />}`. */
const linkedIssueChip = <M>(h: HtmlBuilder<M>, issueId: ErrorIssueId): Html =>
	h.a(
		[
			h.Class(
				cn(
					badgeVariants({
						variant: "meta",
						pill: true,
						size: "sm",
						mono: false,
						className: cn(META_CHIP_CLASS, "z-10 hidden gap-1 sm:inline-flex hover:border-border hover:text-foreground"),
					}),
				),
			),
			h.DataAttribute("slot", "badge"),
			h.Href(hrefOf(AppRoute.ErrorIssue({ issueId, search: {} }))),
			h.Title("Open linked issue"),
		],
		[icon(h, "LinkIcon", { size: 12 }), shortIssueId(issueId)],
	)
