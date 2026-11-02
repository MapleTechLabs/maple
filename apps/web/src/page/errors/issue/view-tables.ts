import type { ErrorIncidentDocument, ErrorIssueSampleTrace } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { statusDot } from "../../../ui/status-dot"
import {
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "../../../ui/table"
import { truncatedId } from "../../../ui/truncated-id"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"

// The issue incidents and occurrences tables.
// TODO(tooltip): the incident status's explanation popup; its trigger is ported.

type Clock = Readonly<{ nowMs: number; timeZone: string }>

const REASON_LABEL = {
	first_seen: "First seen",
	regression: "Regression",
	manual: "Manual",
} satisfies Record<ErrorIncidentDocument["reason"], string>

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
			"tabular-nums text-muted-foreground",
		),
		tableCell(
			h,
			[relativeTime(h, { value: incident.lastTriggeredAt, ...clock, tooltip: "title" })],
			"tabular-nums",
		),
		tableCell(h, [formatNumber(incident.occurrenceCount)], "text-right font-mono tabular-nums"),
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
			"tabular-nums text-muted-foreground",
		),
		tableCell(h, [
			h.span(
				[h.Class("inline-flex items-center gap-1.5")],
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
							"font-mono text-2xs text-muted-foreground tabular-nums",
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
