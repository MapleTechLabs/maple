import { computeServiceShares, type ServiceShare } from "@maple/web/page/traces/detail/derive"
import type { SpanNodeData, TraceData } from "@maple/views/traces/trace-data"
import { getServiceColor } from "@maple/ui/lib/colors"
import { countLabel, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { statFigure } from "@maple/views/ui/stat-figure"
import { statusDot } from "@maple/views/ui/status-dot"
import { traceIdBadge } from "@maple/views/ui/trace-badges"
import { serviceDot } from "@maple/views/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"
import { hstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"

// The @maple/ui `TraceAnatomyStrip` as local mode renders it: no start time, no commit.
// copied: the spectrum bar of apps/web/src/page/traces/detail/view-summary.ts.

/** An Error status, or an HTTP status in the critical band, anywhere in the trace (as on web). */
export const traceHasError = (trace: TraceData): boolean =>
	Arr.some(trace.spans, (span) => {
		if (span.statusCode === "Error") return true
		const raw =
			span.spanAttributes["http.response.status_code"] || span.spanAttributes["http.status_code"]
		const code = raw ? Number.parseInt(raw, 10) : Number.NaN
		return Number.isFinite(code) && httpStatusTone(code) === "crit"
	})

/** The first real root: an orphan's synthetic "missing" parent can sort ahead of it. */
export const rootSpanOf = (trace: TraceData): SpanNodeData | undefined =>
	Option.getOrElse(
		Arr.findFirst(trace.rootSpans, (span) => span.isMissing !== true),
		() => trace.rootSpans[0],
	)

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
				Arr.map(shares, (share) =>
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
	hstack(h, { as: "span", gap: "1.5", className: typographyClass({ size: "xs", mono: true }) }, [
		serviceDot(h, { serviceName: share.serviceName, size: "sm" }),
		h.span([], [share.serviceName]),
		typography(h, { size: "3xs", tone: "muted", numeric: true }, [formatPercent(share.percent / 100)]),
	])

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
		Arr.filter(
			[
				h.div(
					[h.Class("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1")],
					[
						statFigure(h, {
							value: formatDuration(trace.totalDurationMs),
							unit: `${countLabel(trace.spans.length, "span")} · ${countLabel(shares.length, "service")}`,
							className: "min-w-0",
						}),
						hstack(
							h,
							{
								wrap: true,
								shrink: true,
								className: cn(
									"gap-x-3 gap-y-1",
									typographyClass({ size: "xs", tone: "muted" }),
								),
							},
							Arr.filter(
								[
									hstack(
										h,
										{
											as: "span",
											gap: "1.5",
											className: cn(
												typographyClass({ weight: "medium" }),
												hasError ? "text-severity-error" : "text-severity-info",
											),
										},
										[
											statusDot(h, { tone: hasError ? "crit" : "ok" }),
											hasError ? "Error" : "OK",
										],
									),
									httpStatusCode === undefined || httpStatusCode === null
										? null
										: h.span(
												[
													h.Class(
														cn(
															"font-mono font-medium",
															httpStatusColor(httpStatusCode),
														),
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
								],
								(child) => child !== null,
							),
						),
					],
				),
				spectrumBar(h, shares),
				hstack(
					h,
					{ wrap: true, className: "gap-x-4 gap-y-1" },
					Arr.map(shares, (share) => shareChip(h, share)),
				),
			],
			(child) => child !== null,
		),
	)
}
