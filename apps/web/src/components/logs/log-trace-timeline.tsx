import { useEffect, useRef } from "react"
import { shortId } from "@maple/ui/lib/ids"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ErrorState } from "@/components/common/error-state"
import { cn } from "@maple/ui/lib/utils"
import { getSeverityColor } from "@maple/ui/lib/severity"
import type { Log, LogsResponse } from "@/api/warehouse/logs"
import type { SpanHierarchyResponse } from "@/api/warehouse/traces"
import { listLogsResultAtom, getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { computeTraceTimeWindow } from "@/lib/trace-time-window"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { formatDuration } from "@maple/domain/format"

const LOG_LIMIT = 200

/** Offset within the trace (`+12.0ms`), not a relative-time label. Negative is clock skew. */
function formatTimelineOffset(ms: number): string {
	return ms < 0 ? `\u2212${formatDuration(-ms)}` : `+${formatDuration(ms)}`
}

function isCurrentLog(log: Log, currentLog: Log): boolean {
	return (
		log.timestamp === currentLog.timestamp &&
		log.spanId === currentLog.spanId &&
		log.body === currentLog.body
	)
}

interface LogTraceTimelineProps {
	currentLog: Log
	onLogSelect: (log: Log) => void
}

/**
 * Timeline of every log in the current log's trace, with span boundaries.
 * Depends only on query atoms — usable in the drawer and on the standalone
 * `/logs/$logId` page alike.
 */
export function LogTraceTimeline({ currentLog, onLogSelect }: LogTraceTimelineProps) {
	// Bound the trace's logs to a window around this log so ClickHouse can prune
	// partitions (and so logs older than the default 24h window still resolve),
	// mirroring the span-hierarchy query below.
	const window = computeTraceTimeWindow(currentLog.timestamp)
	const logsResult = useAtomValue(
		currentLog.traceId
			? listLogsResultAtom({ data: { traceId: currentLog.traceId, limit: LOG_LIMIT, ...window } })
			: disabledResultAtom<LogsResponse>(),
	)
	const spansResult = useAtomValue(
		currentLog.traceId
			? getSpanHierarchyResultAtom({
					data: { traceId: currentLog.traceId, timestamp: currentLog.timestamp },
				})
			: disabledResultAtom<SpanHierarchyResponse>(),
	)
	const currentLogRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (currentLogRef.current) {
			currentLogRef.current.scrollIntoView({ block: "nearest" })
		}
	}, [currentLog])

	if (!currentLog.traceId) return null

	const returned = Result.isSuccess(logsResult) ? logsResult.value.data.length : 0
	// The query caps at LOG_LIMIT and has no ordering param, so a full page is a sample.
	const truncated = returned >= LOG_LIMIT
	const logCount = returned > 1 ? (truncated ? `${LOG_LIMIT}+` : String(returned)) : null
	const spanTraceStart = Result.isSuccess(spansResult) ? spansResult.value.traceStartTime : undefined

	return (
		<div className="space-y-1.5">
			<h4 className="text-xs font-medium text-muted-foreground">
				Trace Timeline
				{logCount !== null && (
					<span
						className="ml-1 text-muted-foreground/60"
						title={truncated ? `Showing the first ${LOG_LIMIT} logs returned` : undefined}
					>
						{logCount}
					</span>
				)}
			</h4>
			{Result.builder(logsResult)
				.onInitial(() => (
					<SkeletonList
						rows={5}
						className="gap-0 overflow-hidden rounded-md border"
						renderRow={() => (
							<div className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0">
								<Skeleton className="h-3 w-10 shrink-0" />
								<Skeleton className="h-3 w-16 shrink-0" />
								<Skeleton className="h-3 flex-1" />
							</div>
						)}
					/>
				))
				.onError((error) => (
					<ErrorState error={error} title="Failed to load trace logs" variant="inline" />
				))
				.onSuccess((data) => {
					const logs = data.data.toSorted((a, b) => a.exactTimestamp.localeCompare(b.exactTimestamp))

					if (logs.length <= 1) {
						return <EmptyMessage>No other logs in this trace</EmptyMessage>
					}

					// Offsets read from the trace's first span; without spans, from the first log shown.
					const spanStartMs = spanTraceStart ? new Date(spanTraceStart).getTime() : Number.NaN
					const traceStart = Number.isFinite(spanStartMs)
						? spanStartMs
						: new Date(logs[0].timestamp).getTime()

					const spanNameMap = new Map<string, string>()
					if (Result.isSuccess(spansResult)) {
						for (const span of spansResult.value.spans) {
							spanNameMap.set(span.spanId, span.spanName)
						}
					}

					return (
						<>
							<div className="rounded-md border overflow-hidden">
								{logs.map((log, i) => {
									const isCurrent = isCurrentLog(log, currentLog)
									const relativeMs = new Date(log.timestamp).getTime() - traceStart
									const prevLog = i > 0 ? logs[i - 1] : null
									const spanChanged =
										prevLog !== null && prevLog.spanId !== log.spanId
											? log.spanId
											: undefined

									return (
										<div key={`${log.timestamp}-${log.spanId}-${log.body.slice(0, 20)}`}>
											{spanChanged && (
												<div className="flex items-center gap-2 px-2 py-0.5 bg-muted/30">
													<div className="h-px flex-1 bg-border" />
													<span className="text-4xs font-mono text-muted-foreground/60 shrink-0 truncate max-w-[200px]">
														{spanNameMap.get(spanChanged) ??
															shortId(spanChanged, "span")}
													</span>
													<div className="h-px flex-1 bg-border" />
												</div>
											)}
											<div
												ref={isCurrent ? currentLogRef : undefined}
												style={{
													borderLeftColor: getSeverityColor(log.severityText),
												}}
												className={cn(
													"border-l-2 flex items-center gap-1.5 px-2 py-1 text-xs font-mono cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors",
													isCurrent && "bg-primary/8",
												)}
												onClick={() => {
													if (!isCurrent) onLogSelect(log)
												}}
											>
												<span
													className={cn(
														"text-3xs tabular-nums shrink-0 w-[56px] truncate text-right",
														relativeMs < 0
															? "text-severity-warn"
															: "text-muted-foreground",
													)}
													title={
														Number.isFinite(spanStartMs)
															? "Offset from the trace start"
															: "Offset from the first log shown"
													}
												>
													{formatTimelineOffset(relativeMs)}
												</span>
												{log.serviceName !== currentLog.serviceName && (
													<span className="flex max-w-[72px] shrink-0 items-center gap-1 truncate text-3xs text-muted-foreground/60">
														<ServiceDot serviceName={log.serviceName} size="sm" />
														<span className="truncate">{log.serviceName}</span>
													</span>
												)}
												<span
													className={cn(
														"min-w-0 flex-1 truncate text-2xs",
														isCurrent ? "text-foreground" : "text-foreground/80",
													)}
												>
													{log.body}
												</span>
											</div>
										</div>
									)
								})}
							</div>
						</>
					)
				})
				.render()}
		</div>
	)
}
