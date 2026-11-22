import {
	ERROR_INCIDENT_AUTO_RESOLVE_MINUTES,
	type ErrorIncidentDocument,
	type ErrorIssueSampleTrace,
} from "@maple/domain/http"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { statusDot } from "@maple/views/ui/status-dot"
import {
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
	clickableRowClass,
} from "@maple/views/ui/table"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { serviceLabel } from "@maple/views/ui/service-label"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { textLink } from "@maple/views/ui/text-link"
import { hstack } from "@maple/views/ui/stack"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import { Array as Arr, String as Str } from "effect"

type Clock = Readonly<{ nowMs: number; timeZone: string }>

const REASON_LABEL = {
	first_seen: "First seen",
	regression: "Regression",
	manual: "Manual",
} satisfies Record<ErrorIncidentDocument["reason"], string>

// Nothing asks you to close an incident, so `resolved` is spelled out.
const STATUS_EXPLANATION = {
	open: "Open until the error goes quiet, or you mark the issue Done.",
	resolved: `Incidents resolve on their own when the error goes quiet: no new occurrences for ${ERROR_INCIDENT_AUTO_RESOLVE_MINUTES} minutes after the last one. Marking the issue Done resolves its open incidents too.`,
} satisfies Record<ErrorIncidentDocument["status"], string>

const incidentRow = <M>(h: HtmlBuilder<M>, incident: ErrorIncidentDocument, clock: Clock): Html => {
	const isOpen = incident.status === "open"
	return tableRow(h, [
		tableCell(
			h,
			[
				h.span([
					h.AriaHidden(true),
					h.Class(cn("block h-full w-[3px]", isOpen ? "bg-severity-error" : "bg-border-subtle")),
				]),
			],
			"w-8 p-0",
		),
		tableCell(h, [
			hstack(
				h,
				{
					gap: "2",
					align: "center",
					inline: true,
					as: "span",
					className: "cursor-default",
					attributes: [
						h.DataAttribute("base-ui-tooltip-trigger", ""),
						h.Tabindex(0),
						...tooltipTrigger(h, STATUS_EXPLANATION[incident.status]),
					],
				},
				[
					statusDot(h, { tone: isOpen ? "crit" : "neutral" }),
					eyebrow(h, { variant: "label", className: isOpen ? "text-severity-error" : undefined }, [
						Str.capitalize(incident.status),
					]),
				],
			),
		]),
		tableCell(h, [REASON_LABEL[incident.reason]], "text-muted-foreground"),
		tableCell(
			h,
			[relativeTime(h, { value: incident.firstTriggeredAt, ...clock })],
			typographyClass({ tone: "muted", numeric: true }),
		),
		tableCell(h, [relativeTime(h, { value: incident.lastTriggeredAt, ...clock })], "tabular-nums"),
		tableCell(
			h,
			[formatNumber(incident.occurrenceCount)],
			typographyClass({ mono: true, numeric: true, className: "text-right" }),
		),
	])
}

export const incidentsTable = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<ErrorIncidentDocument>,
	clock: Clock,
): Html =>
	incidents.length === 0
		? empty(h, [
				emptyHeader(h, [
					emptyTitle(h, ["No incidents yet"]),
					emptyDescription(h, ["Incidents open on first-seen or regression events."]),
				]),
				docsLink(h, "errors"),
			])
		: table(h, {}, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, [], "w-8 p-0", [h.AriaLabel("Status accent")]),
						tableHead(h, ["Status"]),
						tableHead(h, ["Reason"]),
						tableHead(h, ["Opened"]),
						tableHead(h, ["Last triggered"]),
						tableHead(h, ["Events"], "text-right"),
					]),
				]),
				tableBody(
					h,
					Arr.map(incidents, (incident) => incidentRow(h, incident, clock)),
				),
			])

/**
 * Which columns earn their place. A service, message or environment every sample shares says
 * nothing per row; a release or a user is worth a column as soon as any sample carries one.
 */
type OccurrenceColumns = Readonly<{
	service: boolean
	message: boolean
	environment: boolean
	release: boolean
	user: boolean
}>

const isVaried = (values: ReadonlyArray<string>): boolean => new Set(values).size > 1
const isAnySet = (values: ReadonlyArray<string>): boolean => Arr.some(values, (value) => value !== "")

export const occurrenceColumnsOf = (traces: ReadonlyArray<ErrorIssueSampleTrace>): OccurrenceColumns => ({
	service: isVaried(Arr.map(traces, (trace) => trace.serviceName)),
	message: isVaried(Arr.map(traces, (trace) => trace.exceptionMessage)),
	environment: isVaried(Arr.map(traces, (trace) => trace.deploymentEnv)),
	release: isAnySet(Arr.map(traces, (trace) => trace.serviceVersion)),
	user: isAnySet(Arr.map(traces, (trace) => trace.userId)),
})

export type OccurrenceTableOptions = Readonly<{
	columns: OccurrenceColumns
	/** A user's page, for the User column's links. */
	userHref: (userId: string) => string
}>

/** The value's view or, when the span carried none, the muted empty mark; built only when set. */
const valueOrEmpty = <M>(h: HtmlBuilder<M>, value: string, content: () => Html): Html =>
	value === "" ? typography(h, { tone: "faint" }, [EMPTY_VALUE]) : content()

// The trace link is stretched over its row, so a click anywhere opens the trace; the user
// link sits above it.
const STRETCHED_LINK = "after:absolute after:inset-0 after:content-['']"
const ABOVE_STRETCHED = "relative z-10"

const occurrenceRow = <M>(
	h: HtmlBuilder<M>,
	trace: ErrorIssueSampleTrace,
	clock: Clock,
	options: OccurrenceTableOptions,
): Html => {
	const { columns } = options
	return tableRow(
		h,
		[
			tableCell(
				h,
				[relativeTime(h, { value: trace.timestamp, ...clock })],
				typographyClass({ tone: "muted", numeric: true, className: "whitespace-nowrap" }),
			),
			...(columns.service
				? [
						tableCell(h, [
							serviceLabel(h, { serviceName: trace.serviceName, dot: "sm", truncate: "none" }),
						]),
					]
				: []),
			...(columns.message
				? [
						truncatedTableCell(h, [
							truncatedText(h, { text: trace.exceptionMessage }, [
								Arr.headNonEmpty(Str.split("\n")(trace.exceptionMessage)),
							]),
						]),
					]
				: []),
			...(columns.environment
				? [
						tableCell(h, [
							valueOrEmpty(h, trace.deploymentEnv, () =>
								typography(h, {}, [trace.deploymentEnv]),
							),
						]),
					]
				: []),
			...(columns.release
				? [
						tableCell(
							h,
							[
								valueOrEmpty(h, trace.serviceVersion, () =>
									typography(h, { size: "xs", mono: true }, [trace.serviceVersion]),
								),
							],
							"whitespace-nowrap",
						),
					]
				: []),
			...(columns.user
				? [
						truncatedTableCell(h, [
							valueOrEmpty(h, trace.userId, () =>
								textLink(
									h,
									{
										href: options.userHref(trace.userId),
										isMono: true,
										className: cn(ABOVE_STRETCHED, "block min-w-0"),
										attributes: [h.Title(trace.userId)],
									},
									[
										typography(h, { size: "xs", mono: true, truncate: true }, [
											trace.userId,
										]),
									],
								),
							),
						]),
					]
				: []),
			tableCell(
				h,
				[formatDuration(trace.durationMicros / 1000)],
				typographyClass({ mono: true, numeric: true, className: "text-right whitespace-nowrap" }),
			),
			tableCell(
				h,
				[
					h.a(
						[
							h.Href(
								hrefOf(
									AppRoute.Trace({
										traceId: trace.traceId,
										search: { t: trace.timestamp },
									}),
								),
							),
							h.AriaLabel(`Open trace ${trace.traceId}`),
							h.Class(
								cn(
									"inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-sunken px-2 py-0.5",
									typographyClass({
										size: "2xs",
										tone: "muted",
										mono: true,
										numeric: true,
									}),
									"group-hover/occurrence:border-primary-a4 group-hover/occurrence:bg-primary-a2 group-hover/occurrence:text-primary",
									STRETCHED_LINK,
								),
							),
						],
						[truncatedId(h, { value: trace.traceId, length: 12, ellipsis: true })],
					),
				],
				"text-right",
			),
		],
		cn("group/occurrence relative", clickableRowClass()),
		[h.Key(`${trace.traceId}:${trace.spanId}`)],
	)
}

/** Sampled occurrences, newest first; a row opens its trace. */
export const occurrencesTable = <M>(
	h: HtmlBuilder<M>,
	traces: ReadonlyArray<ErrorIssueSampleTrace>,
	clock: Clock,
	options: OccurrenceTableOptions,
): Html =>
	traces.length === 0
		? empty(h, [
				emptyHeader(h, [
					emptyTitle(h, ["No samples in this window"]),
					emptyDescription(h, [
						"This fingerprint was not seen in this window. Widen the time range to find traces to open.",
					]),
				]),
			])
		: table(h, {}, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Time"]),
						...(options.columns.service ? [tableHead(h, ["Service"])] : []),
						...(options.columns.message ? [tableHead(h, ["Message"])] : []),
						...(options.columns.environment ? [tableHead(h, ["Environment"])] : []),
						...(options.columns.release ? [tableHead(h, ["Release"])] : []),
						...(options.columns.user ? [tableHead(h, ["User"])] : []),
						tableHead(h, ["Duration"], "text-right"),
						tableHead(h, ["Trace"], "text-right"),
					]),
				]),
				tableBody(
					h,
					Arr.map(traces, (trace) => occurrenceRow(h, trace, clock, options)),
				),
			])
