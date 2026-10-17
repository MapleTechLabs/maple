import * as React from "react"

import { ServiceDot } from "../service-dot"
import { StatusDot } from "../ui/status-dot"
import { StatFigure } from "../ui/stat-figure"
import { countLabel, formatDuration, formatPercent } from "../../lib/format"
import { httpStatusTone } from "../../lib/http"
import { TONE_TEXT } from "../../lib/tone"
import { cn } from "../../lib/utils"
import { ServiceSpectrumBar, computeServiceShares, type SpectrumSpan } from "./service-spectrum-bar"
import { TraceIdBadge } from "./trace-id-badge"

export interface TraceAnatomyStripProps {
	rootSpans: ReadonlyArray<SpectrumSpan>
	spanCount: number
	totalDurationMs: number
	traceId: string
	hasError: boolean
	httpStatusCode?: number | null
	deploymentEnv?: string
	/** The root's commit, rendered by the app (web links it to the VCS provider). */
	commit?: React.ReactNode
	/** When the trace started, rendered by the app in the viewer's timezone. */
	startedAt?: React.ReactNode
}

// 4xx/5xx follow the shared status tone; 3xx keeps its own blue so redirects stand apart from 2xx.
function httpStatusColor(code: number): string {
	const tone = httpStatusTone(code)
	if (tone !== "neutral") return TONE_TEXT[tone]
	return code >= 300 ? "text-chart-p50" : TONE_TEXT.info
}

/**
 * The trace's vital signs: total duration as the dominant figure, a segmented
 * per-service share of wall-clock time ("where did the time go"), and the
 * remaining trace metadata as one quiet utility row.
 */
export function TraceAnatomyStrip({
	rootSpans,
	spanCount,
	totalDurationMs,
	traceId,
	hasError,
	httpStatusCode,
	deploymentEnv,
	commit,
	startedAt,
}: TraceAnatomyStripProps) {
	const shares = React.useMemo(() => computeServiceShares(rootSpans), [rootSpans])

	return (
		<div className="shrink-0 space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
				<StatFigure
					value={formatDuration(totalDurationMs)}
					unit={`${countLabel(spanCount, "span")} · ${countLabel(shares.length, "service")}`}
					className="min-w-0"
				/>

				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					{startedAt}

					<span
						className={cn(
							"flex items-center gap-1.5 font-medium",
							hasError ? "text-severity-error" : "text-severity-info",
						)}
					>
						<StatusDot tone={hasError ? "crit" : "ok"} />
						{hasError ? "Error" : "OK"}
					</span>

					{httpStatusCode != null && (
						<span className={cn("font-mono font-medium", httpStatusColor(httpStatusCode))}>
							HTTP {httpStatusCode}
						</span>
					)}

					{deploymentEnv && (
						<span
							className={
								deploymentEnv === "production" ? "text-severity-warn" : "text-chart-p50"
							}
						>
							{deploymentEnv}
						</span>
					)}

					{commit}

					<TraceIdBadge traceId={traceId} size="default" className="text-xs max-w-[10rem]" />
				</div>
			</div>

			<ServiceSpectrumBar shares={shares} />

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{shares.map((share) => (
					<span key={share.serviceName} className="flex items-center gap-1.5 font-mono text-xs">
						<ServiceDot serviceName={share.serviceName} size="sm" />
						<span>{share.serviceName}</span>
						<span className="text-3xs text-muted-foreground tabular-nums">
							{formatPercent(share.percent / 100)}
						</span>
					</span>
				))}
			</div>
		</div>
	)
}
