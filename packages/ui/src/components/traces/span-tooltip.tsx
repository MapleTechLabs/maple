import { formatDuration, formatPercent } from "../../lib/format"
import { getServiceColor, calculateSelfTime } from "../../lib/colors"
import { getHttpInfo, httpStatusTone } from "../../lib/http"
import { TONE_TEXT } from "../../lib/tone"
import { getSpanKindLabel } from "../../lib/span-kind"
import { spanStartMs } from "../../lib/span-tree"
import type { SpanNode } from "../../lib/types"
import { MiddleTruncate } from "../ui/middle-truncate"

interface SpanTooltipProps {
	span: SpanNode
	totalDurationMs?: number
	traceStartTime?: string
}

export function SpanTooltipContent({ span, totalDurationMs, traceStartTime }: SpanTooltipProps) {
	const kindLabel = getSpanKindLabel(span.spanKind)

	const serviceColor = getServiceColor(span.serviceName)
	const selfTime = calculateSelfTime(span, span.children)
	const selfTimePercent = span.durationMs > 0 ? (selfTime / span.durationMs) * 100 : 0
	const durationPercent = totalDurationMs ? (span.durationMs / totalDurationMs) * 100 : null

	const startOffset = traceStartTime ? spanStartMs(span) - new Date(traceStartTime).getTime() : null

	const httpInfo = getHttpInfo(span)

	return (
		<div className="space-y-2 font-mono text-xs">
			<div className="flex items-center gap-2">
				{serviceColor && (
					<div className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: serviceColor }} />
				)}
				<span className="font-medium truncate">{span.spanName}</span>
			</div>

			{durationPercent !== null && (
				<div className="space-y-1">
					<div className="flex items-center justify-between text-3xs">
						<span className="text-muted-foreground">Duration</span>
						<span>
							{formatDuration(span.durationMs)} ({formatPercent(durationPercent / 100)})
						</span>
					</div>
					<div className="h-1.5 w-full bg-muted overflow-hidden">
						<div
							className="h-full bg-primary/70"
							style={{ width: `${Math.max(durationPercent, 1)}%` }}
						/>
					</div>
				</div>
			)}

			{span.children.length > 0 && (
				<div className="flex items-center justify-between text-3xs">
					<span className="text-muted-foreground">Self time</span>
					<span>
						{formatDuration(selfTime)} ({formatPercent(selfTimePercent / 100)})
					</span>
				</div>
			)}

			<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-3xs">
				<span className="text-muted-foreground">Service</span>
				<span>{span.serviceName}</span>
				<span className="text-muted-foreground">Kind</span>
				<span>{kindLabel}</span>
				{startOffset !== null && (
					<>
						<span className="text-muted-foreground">Start offset</span>
						{startOffset < 0 ? (
							<span className="text-severity-warn">
								{"−"}
								{formatDuration(Math.abs(startOffset))} (clock skew)
							</span>
						) : (
							<span>+{formatDuration(startOffset)}</span>
						)}
					</>
				)}
				{durationPercent === null && (
					<>
						<span className="text-muted-foreground">Duration</span>
						<span>{formatDuration(span.durationMs)}</span>
					</>
				)}
				<span className="text-muted-foreground">Status</span>
				<span
					className={
						span.statusCode === "Error"
							? "text-severity-error"
							: span.statusCode === "Ok"
								? "text-severity-info"
								: ""
					}
				>
					{span.statusCode || "Unset"}
				</span>
			</div>

			{httpInfo && (
				<div className="border-t border-border pt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-3xs">
					<span className="text-muted-foreground">Method</span>
					<span className="font-medium">{httpInfo.method}</span>
					{httpInfo.statusCode != null && (
						<>
							<span className="text-muted-foreground">HTTP</span>
							<span
								className={
									httpStatusTone(httpInfo.statusCode) === "neutral"
										? "text-severity-info"
										: TONE_TEXT[httpStatusTone(httpInfo.statusCode)]
								}
							>
								{httpInfo.statusCode}
							</span>
						</>
					)}
					{httpInfo.route && (
						<>
							<span className="text-muted-foreground">Route</span>
							<MiddleTruncate text={httpInfo.route} tail={14} className="max-w-[180px]" />
						</>
					)}
				</div>
			)}

			{span.statusMessage && (
				<div className="border-t border-border pt-1.5 text-3xs">
					<span className="text-muted-foreground">Message: </span>
					{span.statusMessage}
				</div>
			)}
		</div>
	)
}
