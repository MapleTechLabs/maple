import {
	computeServiceShares,
	type ServiceShare,
	serviceSpectrumBar,
} from "@maple/views/traces/service-shares"
import { isErrorSpan } from "@maple/views/traces/trace-errors"
import type { SpanNodeData, TraceData } from "@maple/views/traces/trace-data"
import { countLabel, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTextClass } from "@maple/ui/lib/http"
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
/** An Error status, or an HTTP status in the critical band, anywhere in the trace (as on web). */
export const traceHasError = (trace: TraceData): boolean => Arr.some(trace.spans, isErrorSpan)

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
				hstack(
					h,
					{ align: "baseline", justify: "between", wrap: true, className: "gap-x-6 gap-y-1" },
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
															httpStatusTextClass(httpStatusCode),
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
				serviceSpectrumBar(h, shares),
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
