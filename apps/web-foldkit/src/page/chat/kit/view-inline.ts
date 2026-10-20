import type {
	AnnotationSegment,
	InlineErrorData,
	InlineLogData,
	InlineServiceData,
	InlineTraceData,
} from "@maple/domain/chat-annotations"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { formatTimeInTimezone, normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { truncatedId } from "../../../ui/truncated-id"
import { truncatedText } from "../../../ui/truncated-text"
import { latencyValue } from "../../../ui/values"

// The inline reference cards: a service, an error
// fingerprint, a trace and a log line the model wrote as `<<maple:…>>`.

const SHELL = "@container/inline flex w-full flex-col gap-1 rounded-md border border-border bg-muted px-3 py-2"
const LINK_SHELL =
	"transition-colors hover:border-ring/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
const ROW = "flex min-w-0 items-center gap-2.5"
const META = "flex min-w-0 flex-wrap items-center gap-1 ps-6"

const cardClass = (interactive: boolean): string => cn(SHELL, interactive && LINK_SHELL)

const chevron = <M>(h: HtmlBuilder<M>): Html =>
	icon(h, "ChevronRightIcon", {
		className:
			"size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/inline:text-muted-foreground",
	})

const metric = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ width: string; tone?: string; unit?: string; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[h.Class(cn("shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums", options.width, options.tone, options.className))],
		[...children, ...(options.unit === undefined ? [] : [h.span([h.Class("ms-1 font-sans text-muted-foreground")], [options.unit])])],
	)

const serviceChips = <M>(h: HtmlBuilder<M>, services: ReadonlyArray<string>): ReadonlyArray<Html> => {
	const shown = services.slice(0, 4)
	return [
		...shown.map((service) =>
			h.span(
				[
					h.Class("min-w-0 truncate rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 text-2xs text-muted-foreground"),
					h.Title(service),
				],
				[service],
			),
		),
		...(services.length > shown.length
			? [h.span([h.Class("shrink-0 text-2xs text-muted-foreground/70")], ["+", String(services.length - shown.length)])]
			: []),
	]
}

/** A card that opens its subject in a new tab. */
const linkCard = <M>(h: HtmlBuilder<M>, href: string, children: ReadonlyArray<Html>): Html =>
	h.a(
		[h.Href(href), h.Target("_blank"), h.Rel("noreferrer"), h.Class(cn("group/inline", cardClass(true)))],
		children,
	)

const inlineService = <M>(h: HtmlBuilder<M>, data: InlineServiceData): Html =>
	linkCard(h, `/services/${encodeURIComponent(data.name)}`, [
		h.div(
			[h.Class(ROW)],
			[
				icon(h, "ServerIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
				truncatedText(h, { text: data.name, className: "flex-1 text-xs font-medium text-foreground" }, [data.name]),
				...(data.throughputRpm == null
					? []
					: [
							metric(h, { width: "min-w-20", unit: "rpm", tone: "text-muted-foreground", className: "hidden @[26rem]/inline:inline" }, [
								formatNumber(data.throughputRpm),
							]),
						]),
				...(data.errorRate == null
					? []
					: [metric(h, { width: "min-w-14", unit: "err", tone: errorRateClass(data.errorRate / 100) }, [formatErrorRate(data.errorRate / 100)])]),
				...(data.p99Ms != null
					? [metric(h, { width: "min-w-16", unit: "p99" }, [latencyValue(h, { ms: data.p99Ms, scale: "p99" })])]
					: data.p95Ms != null
						? [metric(h, { width: "min-w-16", unit: "p95" }, [latencyValue(h, { ms: data.p95Ms, scale: "p95" })])]
						: []),
				chevron(h),
			],
		),
	])

const inlineError = <M>(h: HtmlBuilder<M>, data: InlineErrorData): Html => {
	const services = data.affectedServices ?? []
	return h.div(
		[h.Class(cardClass(false))],
		[
			h.div(
				[h.Class(ROW)],
				[
					icon(h, "CircleWarningIcon", { className: "size-3.5 shrink-0 text-severity-error" }),
					truncatedText(h, { text: data.errorType, className: "flex-1 text-xs text-foreground" }, [data.errorType]),
					...(data.count == null
						? []
						: [metric(h, { width: "min-w-12", unit: "events", tone: "text-severity-error" }, [formatNumber(data.count)])]),
				],
			),
			...(services.length === 0 ? [] : [h.div([h.Class(META)], serviceChips(h, services))]),
		],
	)
}

const inlineTrace = <M>(h: HtmlBuilder<M>, data: InlineTraceData): Html =>
	linkCard(h, `/traces/${encodeURIComponent(data.id)}`, [
		h.div(
			[h.Class(ROW)],
			[
				icon(h, "PulseIcon", { className: cn("size-3.5 shrink-0", data.hasError ? "text-severity-error" : "text-muted-foreground") }),
				h.span([h.Class("min-w-0 flex-1 truncate text-xs font-medium text-foreground"), h.Title(data.name)], [data.name]),
				...(data.spanCount == null
					? []
					: [
							metric(h, { width: "min-w-12", unit: "spans", tone: "text-muted-foreground", className: "hidden @[26rem]/inline:inline" }, [
								String(data.spanCount),
							]),
						]),
				metric(h, { width: "min-w-14" }, [latencyValue(h, { ms: data.durationMs, scale: "p99" })]),
				chevron(h),
			],
		),
		h.div(
			[h.Class(META)],
			[
				truncatedId(h, { value: data.id, kind: "trace", length: 12, className: "shrink-0 text-2xs text-muted-foreground/70" }),
				...serviceChips(h, data.services ?? []),
			],
		),
	])

/** `SeverityBadge`: the severity's own colour on a 10% wash of it. */
const severityBadge = <M>(h: HtmlBuilder<M>, severity: string): Html => {
	const label = severity.trim() === "" ? "UNSET" : severity
	const color = getSeverityColor(label)
	return badge(
		h,
		{
			variant: "secondary",
			className: "font-mono text-3xs uppercase shrink-0",
			attributes: [h.Style({ color, "background-color": `color-mix(in oklch, ${color} 10%, transparent)` })],
		},
		[label],
	)
}

const inlineLog = <M>(h: HtmlBuilder<M>, data: InlineLogData, timeZone: string): Html =>
	h.div(
		[h.Class(cardClass(false))],
		[
			h.div(
				[h.Class(ROW)],
				[
					severityBadge(h, data.severity),
					...(data.serviceName ? [h.span([h.Class("max-w-40 shrink-0 truncate text-xs text-muted-foreground")], [data.serviceName])] : []),
					truncatedText(h, { text: data.body, className: "flex-1 text-xs text-foreground" }, [data.body]),
					...(data.timestamp
						? [
								h.span(
									[h.Class("shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")],
									[formatTimeInTimezone(normalizeTimestampInput(data.timestamp), { timeZone, withSeconds: true })],
								),
							]
						: []),
					...(data.traceId
						? [
								h.a(
									[
										h.Href(
											`/traces/${encodeURIComponent(data.traceId)}${data.timestamp ? `?t=${encodeURIComponent(JSON.stringify(data.timestamp))}` : ""}`,
										),
										h.Target("_blank"),
										h.Rel("noreferrer"),
										h.Class(
											"shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
										),
										h.Title(data.traceId),
									],
									["trace"],
								),
							]
						: []),
				],
			),
		],
	)

export const inlineCard = <M>(
	h: HtmlBuilder<M>,
	segment: Exclude<AnnotationSegment, { type: "text" }>,
	timeZone: string,
): Html => {
	switch (segment.type) {
		case "service":
			return inlineService(h, segment.data)
		case "error":
			return inlineError(h, segment.data)
		case "trace":
			return inlineTrace(h, segment.data)
		case "log":
			return inlineLog(h, segment.data, timeZone)
	}
}
