import { computeServiceShares, type ServiceShare } from "@maple/web/page/traces/detail/derive"
import type { SpanNodeData, TraceData } from "@maple/web/page/traces/detail/trace-data"
import { getServiceColor } from "@maple/ui/lib/colors"
import { countLabel, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { statFigure } from "@maple/web/ui/stat-figure"
import { statusDot } from "@maple/web/ui/status-dot"
import { traceIdBadge } from "@maple/web/ui/trace-badges"
import { serviceDot } from "@maple/web/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"

// The @maple/ui `TraceAnatomyStrip` as local mode renders it: no start time, no commit.
// copied: the spectrum bar of apps/web/src/page/traces/detail/view-summary.ts.

/** An Error status, or an HTTP status in the critical band, anywhere in the trace (as on web). */
export const traceHasError = (trace: TraceData): boolean =>
	trace.spans.some((span) => {
		if (span.statusCode === "Error") return true
		const raw =
			span.spanAttributes["http.response.status_code"] || span.spanAttributes["http.status_code"]
		const code = raw ? Number.parseInt(raw, 10) : Number.NaN
		return Number.isFinite(code) && httpStatusTone(code) === "crit"
	})

/** The first real root: an orphan's synthetic "missing" parent can sort ahead of it. */
export const rootSpanOf = (trace: TraceData): SpanNodeData | undefined =>
	trace.rootSpans.find((span) => span.isMissing !== true) ?? trace.rootSpans[0]

export const httpInfoOf = (span: SpanNodeData) =>
	getHttpInfo({
		spanName: span.spanName,
		spanAttributes: { ...span.spanAttributes },
		spanKind: span.spanKind,
	})

export const httpStatusOf = (span: SpanNodeData): number | null | undefined => httpInfoOf(span)?.statusCode

const httpStatusColor = (code: number): string => {
	const tone = httpStatusTone(code)
	if (tone !== "neutral") return TONE_TEXT[tone]
	return code >= 300 ? "text-chart-p50" : TONE_TEXT.info
}

const spectrumBar = (h: HtmlBuilder<Message>, shares: ReadonlyArray<ServiceShare>): Html | null =>
	shares.length === 0
		? null
		: h.div(
				[h.Class("flex h-1.5 w-full gap-px overflow-hidden rounded-full")],
				shares.map((share) =>
					h.span(
						[
							h.Class("h-full"),
							h.DataAttribute("base-ui-tooltip-trigger", ""),
							h.DataAttribute("slot", "tooltip-trigger"),
							h.Style({
								width: `${share.percent}%`,
								"min-width": "4px",
								"background-color": getServiceColor(share.serviceName),
							}),
						],
						[],
					),
				),
			)

const shareChip = (h: HtmlBuilder<Message>, share: ServiceShare): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5 font-mono text-xs")],
		[
			serviceDot(h, { serviceName: share.serviceName, size: "sm" }),
			h.span([], [share.serviceName]),
			h.span(
				[h.Class("text-3xs text-muted-foreground tabular-nums")],
				[formatPercent(share.percent / 100)],
			),
		],
	)

/** The trace's vital signs: total duration, the per-service share of wall-clock time, metadata. */
export const anatomyStrip = (h: HtmlBuilder<Message>, trace: TraceData): Html => {
	const root = rootSpanOf(trace)
	const shares = computeServiceShares(trace.rootSpans)
	const hasError = traceHasError(trace)
	const httpStatusCode = root === undefined ? undefined : httpStatusOf(root)
	const resource = root?.resourceAttributes ?? {}
	const deploymentEnv = resource["deployment.environment.name"] || resource["deployment.environment"]
	return h.div(
		[h.Class("shrink-0 space-y-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1")],
				[
					statFigure(h, {
						value: formatDuration(trace.totalDurationMs),
						unit: `${countLabel(trace.spans.length, "span")} · ${countLabel(shares.length, "service")}`,
						className: "min-w-0",
					}),
					h.div(
						[
							h.Class(
								"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
							),
						],
						[
							h.span(
								[
									h.Class(
										cn(
											"flex items-center gap-1.5 font-medium",
											hasError ? "text-severity-error" : "text-severity-info",
										),
									),
								],
								[statusDot(h, { tone: hasError ? "crit" : "ok" }), hasError ? "Error" : "OK"],
							),
							httpStatusCode === undefined || httpStatusCode === null
								? null
								: h.span(
										[
											h.Class(
												cn("font-mono font-medium", httpStatusColor(httpStatusCode)),
											),
										],
										["HTTP ", String(httpStatusCode)],
									),
							deploymentEnv === undefined || deploymentEnv === ""
								? null
								: h.span(
										[
											h.Class(
												deploymentEnv === "production"
													? "text-severity-warn"
													: "text-chart-p50",
											),
										],
										[deploymentEnv],
									),
							traceIdBadge(h, trace.traceId, {
								size: "default",
								className: "text-xs max-w-[10rem]",
							}),
						].filter((child) => child !== null),
					),
				],
			),
			spectrumBar(h, shares),
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1")],
				shares.map((share) => shareChip(h, share)),
			),
		].filter((child) => child !== null),
	)
}
