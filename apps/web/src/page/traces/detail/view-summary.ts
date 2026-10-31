import { warehouseDateTimeToIso } from "@maple/query-engine"
import { getServiceColor } from "@maple/ui/lib/colors"
import { countLabel, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { shortId } from "@maple/ui/lib/ids"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { traceIdBadge } from "../../../ui/trace-badges"
import { statFigure } from "../../../ui/stat-figure"
import { statusDot } from "../../../ui/status-dot"
import { serviceDot } from "../../../ui/values"
import { computeServiceShares, type ServiceShare } from "./derive"
import { Message } from "./message"
import type { LoadedTrace } from "./select"

// The trace anatomy strip, over the @maple/ui strip.
// TODO(tooltip): spectrum segment tooltips, the commit hover card and the copy badge's feedback.

const stampFormat = (timeZone: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
	})

const httpStatusColor = (code: number): string => {
	const tone = httpStatusTone(code)
	if (tone !== "neutral") return TONE_TEXT[tone]
	return code >= 300 ? "text-chart-p50" : TONE_TEXT.info
}

/** `TraceStartedAt`: the absolute start in the viewer's zone, with its age. */
const startedAt = (
	h: HtmlBuilder<Message>,
	startTime: string,
	timeZone: string,
	nowMs: number,
): Html | null => {
	const epochMs = new Date(warehouseDateTimeToIso(startTime)).getTime()
	if (Number.isNaN(epochMs)) return null
	return h.time(
		[h.Attribute("datetime", new Date(epochMs).toISOString()), h.Class("tabular-nums")],
		[
			h.span([h.Class("text-foreground")], [stampFormat(timeZone).format(epochMs)]),
			" ",
			"· ",
			formatRelativeTime(epochMs, nowMs),
		],
	)
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

export type AnatomyInput = Readonly<{
	trace: LoadedTrace
	hasError: boolean
	timeZone: string
	nowMs: number
}>

export const anatomyStrip = (h: HtmlBuilder<Message>, input: AnatomyInput): Html => {
	const { trace } = input
	const root = trace.rootSpan
	const shares = computeServiceShares(trace.data.rootSpans)
	const resource = root?.resourceAttributes ?? {}
	const deploymentEnv = resource["deployment.environment.name"] || resource["deployment.environment"]
	const commitSha = resource["vcs.ref.head.revision"]
	const httpStatusCode =
		root === undefined
			? undefined
			: getHttpInfo({
					spanName: root.spanName,
					spanAttributes: { ...root.spanAttributes },
					spanKind: root.spanKind,
				})?.statusCode
	return h.div(
		[h.Class("shrink-0 space-y-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1")],
				[
					statFigure(h, {
						value: formatDuration(trace.data.totalDurationMs),
						unit: `${countLabel(trace.data.spans.length, "span")} · ${countLabel(shares.length, "service")}`,
						className: "min-w-0",
					}),
					h.div(
						[
							h.Class(
								"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
							),
						],
						[
							startedAt(h, trace.traceStartTime, input.timeZone, input.nowMs),
							h.span(
								[
									h.Class(
										cn(
											"flex items-center gap-1.5 font-medium",
											input.hasError ? "text-severity-error" : "text-severity-info",
										),
									),
								],
								[
									statusDot(h, { tone: input.hasError ? "crit" : "ok" }),
									input.hasError ? "Error" : "OK",
								],
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
							commitSha === undefined || commitSha === ""
								? null
								: h.button(
										[
											h.Class(
												"cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground active:text-foreground",
											),
											h.DataAttribute("slot", "hover-card-trigger"),
											h.Type("button"),
										],
										[shortId(commitSha, "sha")],
									),
							traceIdBadge(h, trace.data.traceId, {
								size: "default",
								className: "text-xs max-w-[10rem]",
								onCopy: Message.ClickedCopyTraceId(),
							}),
						],
					),
				],
			),
			spectrumBar(h, shares),
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1")],
				shares.map((share) =>
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
					),
				),
			),
		],
	)
}
