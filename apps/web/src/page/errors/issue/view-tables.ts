import {
	ERROR_INCIDENT_AUTO_RESOLVE_MINUTES,
	type ErrorIncidentDocument,
	type ErrorIssueSampleTrace,
} from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
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
} from "@maple/views/ui/table"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { serviceDot } from "@maple/views/ui/values"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"

// The issue incidents and occurrences tables.

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
			h.span(
				[
					h.Class("inline-flex cursor-default items-center gap-2"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.Tabindex(0),
					...tooltipTrigger(h, STATUS_EXPLANATION[incident.status]),
				],
				[
					statusDot(h, { tone: isOpen ? "crit" : "neutral" }),
					eyebrow(h, { variant: "label", className: isOpen ? "text-severity-error" : undefined }, [
						incident.status,
					]),
				],
			),
		]),
		tableCell(h, [REASON_LABEL[incident.reason]], "text-muted-foreground"),
		tableCell(
			h,
			[relativeTime(h, { value: incident.firstTriggeredAt, ...clock, tooltip: "title" })],
			typographyClass({ tone: "muted", numeric: true }),
		),
		tableCell(
			h,
			[relativeTime(h, { value: incident.lastTriggeredAt, ...clock, tooltip: "title" })],
			"tabular-nums",
		),
		tableCell(h, [formatNumber(incident.occurrenceCount)], typographyClass({ mono: true, numeric: true, className: "text-right" })),
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
					incidents.map((incident) => incidentRow(h, incident, clock)),
				),
			])

const occurrenceRow = <M>(h: HtmlBuilder<M>, trace: ErrorIssueSampleTrace, clock: Clock): Html =>
	tableRow(h, [
		tableCell(
			h,
			[relativeTime(h, { value: trace.timestamp, ...clock, tooltip: "title" })],
			typographyClass({ tone: "muted", numeric: true }),
		),
		tableCell(h, [
			hstack(h, { gap: "1.5", inline: true, as: "span" },
				[
					serviceDot(h, { serviceName: trace.serviceName, size: "sm" }),
					h.span([], [trace.serviceName]),
				],
			),
		]),
		truncatedTableCell(
			h,
			[
				truncatedText(h, { text: trace.exceptionMessage }, [
					trace.exceptionMessage.split("\n", 1)[0] ?? "",
				]),
			],
		),
		tableCell(h, [
			h.a(
				[
					h.Href(
						hrefOf(AppRoute.Trace({ traceId: trace.traceId, search: { t: trace.timestamp } })),
					),
					h.Class(
						cn(
							"inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-sunken px-2 py-0.5",
							typographyClass({ size: "2xs", tone: "muted", mono: true, numeric: true }),
							"hover:border-primary-a4 active:border-primary-a4 hover:bg-primary-a2 active:bg-primary-a2 hover:text-primary active:text-primary",
						),
					),
				],
				[truncatedId(h, { value: trace.traceId, length: 12, ellipsis: true })],
			),
		]),
	])

export const occurrencesTable = <M>(
	h: HtmlBuilder<M>,
	traces: ReadonlyArray<ErrorIssueSampleTrace>,
	clock: Clock,
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
						tableHead(h, ["Service"]),
						tableHead(h, ["Message"]),
						tableHead(h, ["Trace"]),
					]),
				]),
				tableBody(
					h,
					traces.map((trace) => occurrenceRow(h, trace, clock)),
				),
			])
