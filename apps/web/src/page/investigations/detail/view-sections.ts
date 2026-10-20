import type { V2Investigation } from "@maple/domain/http/v2"
import { countLabel, EMPTY_VALUE, formatDuration, formatErrorRate, formatLatency, formatNumber, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { serviceDot } from "../../../ui/values"
import { sectionHeading } from "../../kit/section-heading"
import { ORIGIN } from "../kit"
import { busiestRowOf, type ChipPlace, servicesTouched, signalServiceOf, signalWindowOf, traceTipId } from "./derive"
import { Message } from "./message"
import type { Escalation, LogBucket, Model, OverviewRow, TracesRow } from "./model"

// The Overview's lower sections and the Evidence tab: `ImpactStrip`, `SignalsCard`, `InvestigationMeta`,
// `FollowUpComposer`, `CauseRecap`, `EvidenceTab` and `EvidenceChips`.

type H = HtmlBuilder<Message>

const link = (h: H, href: string, className: string, children: ReadonlyArray<Html | string>): Html =>
	h.a([h.Href(href), h.Class(className)], children)

const STRIP = [
	"grid shrink-0 gap-y-5 px-1",
	"grid-cols-2 xl:grid-cols-4",
	"[&>*]:border-l [&>*]:pl-6",
	"[&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0",
	"xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6",
	"xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0",
].join(" ")

const factLane = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex min-w-0 flex-col gap-1.5")], [eyebrow(h, {}, [label]), h.div([h.Class("min-w-0 text-sm")], children)])

const incidentWindow = (snapshot: V2Investigation["snapshot"], timeZone: string): string => {
	const startedAt = snapshot.incidentStartedAt
	if (!startedAt) return "Not recorded"
	const startMs = toEpochMs(startedAt)
	if (!Number.isFinite(startMs)) return "Not recorded"
	const start = formatTimeInTimezone(startMs, { timeZone })
	const endedAt = snapshot.incidentEndedAt
	if (!endedAt) return `${start} → ongoing`
	const endMs = toEpochMs(endedAt)
	if (!Number.isFinite(endMs) || endMs < startMs) return `${start} → ongoing`
	return `${start} → ${formatTimeInTimezone(endMs, { timeZone })} · ${formatDuration(endMs - startMs)}`
}

/** `ImpactStrip`: scope, services, window and blast radius in ruled lanes. */
export const impactStrip = (h: H, investigation: V2Investigation, timeZone: string): Html => {
	const { report, snapshot } = investigation
	const isSettled = investigation.status !== "investigating"
	const services = servicesTouched(investigation)
	const occurrences = snapshot.occurrenceCount
	return h.div(
		[h.Class(STRIP)],
		[
			factLane(h, "Affected scope", [
				h.span(
					[h.Class("text-foreground")],
					[report?.affectedScope?.trim() || (isSettled ? "Not determined" : "Not yet determined")],
				),
			]),
			factLane(h, "Services touched", [
				services.length === 0
					? h.span([h.Class("text-muted-foreground")], ["None recorded"])
					: h.span(
							[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1.5")],
							services.map((service) =>
								h.keyed("span")(service, [h.Class("flex items-center gap-1.5")], [
									serviceDot(h, { serviceName: service, size: "sm" }),
									h.span([h.Class("text-foreground")], [service]),
								]),
							),
						),
			]),
			factLane(h, "Incident window", [h.span([h.Class("text-foreground tabular-nums")], [incidentWindow(snapshot, timeZone)])]),
			...(occurrences != null && Number.isFinite(occurrences)
				? [
						factLane(h, "Blast radius", [
							h.span(
								[h.Class("text-foreground")],
								[
									h.span([h.Class("tabular-nums")], [formatNumber(occurrences)]),
									" ",
									h.span([h.Class("text-muted-foreground")], [pluralize(occurrences, "event")]),
								],
							),
						]),
					]
				: []),
		],
	)
}

const rowLabel = (h: H, label: string): Html => eyebrow(h, { className: "w-14 shrink-0" }, [label])

const figure = (h: H, value: string, unit: string, tone?: string): Html =>
	h.span(
		[h.Class("flex items-baseline gap-1.5")],
		[
			h.span([h.Class(cn("font-mono text-base text-foreground tabular-nums", tone))], [value]),
			h.span([h.Class("text-xs text-muted-foreground")], [unit]),
		],
	)

const rowSkeleton = (h: H, label: string, height: string): Html =>
	h.div([h.Class("flex items-center gap-4")], [rowLabel(h, label), skeleton(h, cn("flex-1 rounded-md", height))])

const rowNote = (h: H, label: string, note: string): Html =>
	h.div([h.Class("flex items-baseline gap-4")], [rowLabel(h, label), h.span([h.Class("text-sm text-muted-foreground")], [note])])

const segment = (h: H, share: number, color: string): ReadonlyArray<Html> =>
	Number.isFinite(share) && share >= 0.005
		? [h.span([h.Class("w-full shrink-0"), h.Style({ height: `${Math.min(100, share * 100)}%`, "background-color": color })])]
		: []

const logsRow = (h: H, points: ReadonlyArray<typeof LogBucket.Type>): Html => {
	if (points.length === 0) return rowNote(h, "Logs", "No logs in this window")
	const bars = points.map((point) => {
		const entries = Object.entries(point.series)
		const total = entries.reduce((sum, [, count]) => sum + count, 0)
		const errors = entries
			.filter(([severity]) => ["ERROR", "FATAL"].includes(severity.toUpperCase()))
			.reduce((sum, [, count]) => sum + count, 0)
		const warnings = entries
			.filter(([severity]) => ["WARN", "WARNING"].includes(severity.toUpperCase()))
			.reduce((sum, [, count]) => sum + count, 0)
		return { bucket: point.bucket, total, errors, warnings }
	})
	const totals = bars.reduce(
		(sum, bar) => ({ lines: sum.lines + bar.total, errors: sum.errors + bar.errors, warnings: sum.warnings + bar.warnings }),
		{ lines: 0, errors: 0, warnings: 0 },
	)
	const peak = Math.max(...bars.map((bar) => bar.total), 1)
	return h.div(
		[h.Class("flex flex-col gap-2.5")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline gap-x-4 gap-y-1")],
				[
					rowLabel(h, "Logs"),
					figure(h, formatNumber(totals.lines), "lines"),
					figure(h, formatNumber(totals.errors), "errors", totals.errors > 0 ? "text-severity-error" : undefined),
					figure(h, formatNumber(totals.warnings), "warnings", totals.warnings > 0 ? "text-severity-warn" : undefined),
				],
			),
			h.div(
				[h.Class("flex h-10 items-end gap-px"), h.AriaHidden(true)],
				bars.map((bar) =>
					h.keyed("span")(
						bar.bucket,
						[
							h.Title(`${formatNumber(bar.total)} lines${bar.errors ? ` · ${formatNumber(bar.errors)} errors` : ""}`),
							h.Class("flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[1px]"),
							h.Style({ height: `${bar.total === 0 ? 0 : Math.max(6, (bar.total / peak) * 100)}%` }),
						],
						[
							...segment(h, bar.errors / bar.total, SEVERITY_COLORS.ERROR ?? ""),
							...segment(h, bar.warnings / bar.total, SEVERITY_COLORS.WARN ?? ""),
							h.span([h.Class("flex-1"), h.Style({ "background-color": SEVERITY_COLORS.INFO ?? "" })]),
						],
					),
				),
			),
		],
	)
}

/** `SignalsCard`: what the one service did over the incident window, logs then traces. */
export const signalsCard = (h: H, model: Model, investigation: V2Investigation): Html | null => {
	const window = signalWindowOf(investigation)
	const service = signalServiceOf(investigation)
	if (window === null || service === null) return null
	const logs = AsyncData.match(model.logs.data, {
		onIdle: () => rowSkeleton(h, "Logs", "h-10"),
		onLoading: () => rowSkeleton(h, "Logs", "h-10"),
		onFailure: () => rowNote(h, "Logs", "Could not be loaded"),
		onStale: () => rowNote(h, "Logs", "Could not be loaded"),
		onSuccess: (points) => logsRow(h, points),
		onRefreshing: (points) => logsRow(h, points),
	})
	const tracesRow = (rows: ReadonlyArray<OverviewRow>) => tracesFigures(busiestRowOf(rows, service))
	const tracesFigures = (row: typeof TracesRow.Type | null) =>
		row === null
			? rowNote(h, "Traces", "No spans in this window")
			: h.div(
					[h.Class("flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-3.5")],
					[
						rowLabel(h, "Traces"),
						figure(h, formatNumber(row.spanCount), "spans"),
						figure(h, formatLatency(row.p95LatencyMs), "p95"),
						figure(h, formatErrorRate(row.errorRate), "error rate", row.errorRate > 0 ? "text-severity-error" : undefined),
						h.span([h.Class("flex-1")]),
						link(h, "/traces", "shrink-0 text-xs text-primary hover:underline", ["View traces →"]),
					],
				)
	const traces = AsyncData.match(model.traces.data, {
		onIdle: () => rowSkeleton(h, "Traces", "h-5"),
		onLoading: () => rowSkeleton(h, "Traces", "h-5"),
		onFailure: () => rowNote(h, "Traces", "Could not be loaded"),
		onStale: () => rowNote(h, "Traces", "Could not be loaded"),
		onSuccess: tracesRow,
		onRefreshing: tracesRow,
	})
	return panel(h, { className: "shrink-0 gap-4 px-5 py-4" }, [
		h.header(
			[h.Class("flex items-center gap-2")],
			[
				serviceDot(h, { serviceName: service }),
				h.span([h.Class("min-w-0 truncate font-mono text-sm text-foreground"), h.Title(service)], [service]),
				window.label
					? h.span([h.Class("min-w-0 flex-1 truncate text-xs text-muted-foreground")], ["· ", window.label])
					: h.span([h.Class("flex-1")]),
				link(h, `/services/${encodeURIComponent(service)}`, "shrink-0 text-xs text-primary hover:underline", ["Open service →"]),
			],
		),
		logs,
		traces,
	])
}

const pair = (h: H, label: string, children: ReadonlyArray<Html | string>): Html =>
	h.span(
		[h.Class("flex min-w-0 items-baseline gap-2")],
		[
			h.span([h.Class("shrink-0 text-muted-foreground"), h.Title(label)], [label]),
			h.span([h.Class("min-w-0 truncate text-foreground")], children),
		],
	)

const ESCALATION_LABEL = { queued: "Queued", sent: "Sent", skipped: "Skipped", failed: "Failed" } as const

/** `Escalation`: whether this run's diagnosis reached anyone; absent while loading or on failure. */
const escalation = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.match(model.escalation.data, {
		onIdle: () => [],
		onLoading: () => [],
		onFailure: () => [],
		onStale: () => [],
		onSuccess: (attempt) => escalationPair(h, attempt),
		onRefreshing: (attempt) => escalationPair(h, attempt),
	})

const escalationPair = (h: H, attempt: typeof Escalation.Type | null): ReadonlyArray<Html> => {
	if (attempt === null) return []
	const failedCount = attempt.destinations.filter((destination) => destination.status === "failed").length
	return [
		pair(h, "Escalation", [
			h.span(
				[
					h.Class(attempt.status === "failed" ? "text-severity-error" : "text-foreground"),
					h.Title(attempt.destinations.map((destination) => `${destination.name}: ${destination.status}`).join("\n")),
				],
				[
					ESCALATION_LABEL[attempt.status],
					attempt.destinations.length > 0 ? ` · ${countLabel(attempt.destinations.length, "destination")}` : "",
					failedCount > 0 ? ` · ${failedCount} failed` : "",
				],
			),
		]),
	]
}

const referenceLink = (h: H, label: string, url: string): Html =>
	url.startsWith("/")
		? link(h, url, "truncate text-primary hover:underline", [label])
		: h.a([h.Href(url), h.Attribute("rel", "noreferrer"), h.Attribute("target", "_blank"), h.Class("truncate text-primary hover:underline")], [label])

/** `InvestigationMeta`: the audit trail under the finding. */
export const investigationMeta = (h: H, model: Model, investigation: V2Investigation): Html => {
	const { snapshot, subject } = investigation
	const issueId = subject.type === "incident" ? subject.issue_id : null
	const input = investigation.input_tokens
	const output = investigation.output_tokens
	const tokens =
		input === null && output === null
			? null
			: `${input === null ? EMPTY_VALUE : formatNumber(input)} in · ${output === null ? EMPTY_VALUE : formatNumber(output)} out`
	const opened = investigation.seeded_by === "system" ? "Opened automatically by Maple" : "Opened by a member of your team"
	return h.section(
		[h.Class("flex shrink-0 flex-col gap-3 border-t pt-5")],
		[
			eyebrow(h, { as: "h2", className: "block mb-0" }, ["Linked"]),
			h.div(
				[h.Class("flex flex-wrap items-baseline gap-x-8 gap-y-2.5 text-xs")],
				[
					pair(h, "Origin", [h.span([h.Class("text-foreground")], [ORIGIN[investigation.seeded_by]])]),
					...(issueId
						? [
								pair(h, "Issue", [
									h.a(
										[
											h.Href(`/errors/issues/${issueId}`),
											h.Title(issueId),
											h.Class("max-w-60 truncate font-mono text-primary hover:underline"),
										],
										[issueId],
									),
								]),
							]
						: []),
					...(subject.type === "incident"
						? [pair(h, "Incident", [h.code([h.Title(subject.incident_id), h.Class("max-w-60 truncate font-mono")], [subject.incident_id])])]
						: []),
					...snapshot.references.map((reference) => pair(h, reference.label, [referenceLink(h, reference.label, reference.url)])),
					...(issueId ? escalation(h, model) : []),
				],
			),
			h.p([h.Class("text-2xs text-muted-foreground")], [[investigation.model, tokens, opened].filter(Boolean).join(" · ")]),
		],
	)
}

/** `FollowUpComposer`: hands the question to the Chat tab. */
export const followUpComposer = (h: H): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedFollowUp()),
			h.Class(
				"flex h-10.5 w-full items-center gap-3 rounded-md border border-input bg-card px-3.5 text-left transition-colors hover:border-ring hover:bg-accent/40",
			),
		],
		[
			icon(h, "ChatBubbleSparkleIcon", { size: 14, className: "shrink-0 text-primary" }),
			h.span(
				[h.Class("min-w-0 flex-1 truncate text-sm text-muted-foreground")],
				["Ask a follow-up — challenge the cause, widen the window, check another service…"],
			),
			h.span(
				[h.AriaHidden(true), h.Class("flex size-6.5 shrink-0 items-center justify-center rounded-md bg-muted")],
				[icon(h, "ArrowUpIcon", { size: 12, className: "text-muted-foreground" })],
			),
		],
	)

type EvidenceItem = NonNullable<V2Investigation["report"]>["evidence"][number]

/** The trace tooltip's trigger attributes, by trigger id. */
export type TipTrigger = (id: string) => ReadonlyArray<ChildAttribute>

/** `EvidenceChips`: the traces (full id on a tooltip) and log patterns behind a finding. */
export const evidenceChips = (h: H, item: EvidenceItem, place: ChipPlace, trigger: TipTrigger): Html | null =>
	item.traceIds.length === 0 && item.logPatterns.length === 0
		? null
		: h.div(
				[h.Class("flex flex-wrap items-center gap-1.5")],
				[
					...item.traceIds.map((traceId) =>
						h.keyed("a")(
							traceId,
							[h.Href(`/traces/${traceId}`), h.Class("rounded"), ...trigger(traceTipId(place, traceId))],
							[
								inlineCode(h, { className: "px-1.5 py-0.5 text-2xs text-primary transition-colors hover:bg-muted/70" }, [
									shortId(traceId, "generic", { ellipsis: true }),
								]),
							],
						),
					),
					...item.logPatterns.map((pattern) =>
						inlineCode(h, { className: "bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground" }, [pattern]),
					),
				],
			)

/** `CauseRecap`: the suspected cause, one line above the evidence. */
const causeRecap = (h: H, investigation: V2Investigation): ReadonlyArray<Html> => {
	const cause = investigation.report?.suspectedCause?.trim()
	return cause
		? [
				h.div(
					[h.Class("flex shrink-0 items-baseline gap-3 overflow-hidden rounded-r-xl border bg-card py-3 pl-0 pr-5")],
					[
						h.span([h.AriaHidden(true), h.Class("h-full w-[3px] shrink-0 self-stretch bg-primary")]),
						eyebrow(h, { className: "shrink-0 pl-4 text-primary" }, ["Cause"]),
						h.p([h.Class("min-w-0 flex-1 text-sm text-foreground")], [cause]),
					],
				),
			]
		: []
}

const hasContent = (item: EvidenceItem) => item.note !== "" || item.traceIds.length > 0 || item.logPatterns.length > 0

/** `EvidenceTab`. */
export const evidenceTab = (h: H, investigation: V2Investigation, trigger: TipTrigger): Html => {
	const evidence = (investigation.report?.evidence ?? []).filter(hasContent)
	if (evidence.length === 0)
		return h.div(
			[h.Class("flex shrink-0 flex-col gap-6")],
			[
				...causeRecap(h, investigation),
				emptyMessage(h, { className: "py-10 text-sm" }, [
					investigation.status === "investigating"
						? "Evidence appears here as the lenses report."
						: investigation.status === "inconclusive"
							? "This run promoted no cause, so it attached no evidence. What it did rule out is on the Overview."
							: "This pass recorded no evidence.",
				]),
			],
		)
	const traceCount = evidence.reduce((total, item) => total + item.traceIds.length, 0)
	return h.div(
		[h.Class("flex shrink-0 flex-col gap-6")],
		[
			...causeRecap(h, investigation),
			h.section(
				[h.Class("flex shrink-0 flex-col gap-3.5")],
				[
					sectionHeading(h, {
						title: "Evidence",
						hint: `${countLabel(evidence.length, "finding")}${traceCount > 0 ? ` · ${countLabel(traceCount, "trace")}` : ""}`,
					}),
					h.ol(
						[h.Class("flex flex-col border-t")],
						evidence.map((item, index) => {
							const chips = evidenceChips(h, item, "evidence", trigger)
							return h.keyed("li")(
								`${index}:${item.note}`,
								[h.Class("flex items-start gap-4 border-b px-1 py-4")],
								[
									h.span(
										[h.Class("mt-0.5 w-5.5 shrink-0 font-mono text-xs font-medium text-muted-foreground tabular-nums")],
										[String(index + 1).padStart(2, "0")],
									),
									h.div(
										[h.Class("flex min-w-0 flex-1 flex-col gap-2")],
										[
											...(item.note ? [h.p([h.Class("text-sm leading-6 text-foreground")], [item.note])] : []),
											...(chips === null ? [] : [chips]),
										],
									),
								],
							)
						}),
					),
				],
			),
		],
	)
}
