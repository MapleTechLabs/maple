import { useMemo } from "react"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { TraceAnatomyStrip } from "@maple/ui/components/traces/trace-anatomy-strip"
import { TraceIdBadge } from "@maple/ui/components/traces/trace-id-badge"
import { isTraceView, TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import type { Span, SpanNode } from "@maple/ui/lib/types"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"
import { SpanDetailPanel } from "../components/span-detail-panel"
import { RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"
import { useQueryParams } from "../lib/router"

interface TraceDetailViewProps {
	traceId: string
	backLabel: string
	onBack: () => void
}

/** Depth-first lookup of a span in the rendered tree (the panel needs the node, children included). */
function findSpanNode(nodes: ReadonlyArray<SpanNode>, spanId: string): SpanNode | undefined {
	for (const node of nodes) {
		if (node.spanId === spanId) return node
		const found = findSpanNode(node.children, spanId)
		if (found) return found
	}
	return undefined
}

/** An Error status, or an HTTP status in the critical band, anywhere in the trace (as on web). */
function traceHasError(spans: ReadonlyArray<Span>): boolean {
	return spans.some((span) => {
		if (span.statusCode === "Error") return true
		const raw =
			span.spanAttributes["http.response.status_code"] || span.spanAttributes["http.status_code"]
		const code = raw ? Number.parseInt(raw, 10) : Number.NaN
		return Number.isFinite(code) && httpStatusTone(code) === "crit"
	})
}

/** Shaped like the loaded page (strip, spectrum bar, waterfall rows) so nothing jumps when it lands. */
function TraceDetailLoading() {
	return (
		<div className="space-y-4 p-4">
			<div className="space-y-2">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<div className="flex gap-4">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
				</div>
			</div>
			<SkeletonList
				rows={8}
				gap="px"
				className="gap-0 rounded-md border"
				renderRow={() => (
					<div className="flex items-center gap-2 border-b p-3">
						<Skeleton className="size-4" />
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-4 w-16" />
						<Skeleton className="h-4 flex-1" />
						<Skeleton className="h-2 w-32" />
						<Skeleton className="h-4 w-16" />
					</div>
				)}
			/>
		</div>
	)
}

export function TraceDetailView({ traceId, backLabel, onBack }: TraceDetailViewProps) {
	const trace = useLocalTraceDetail(traceId)
	const [query, setParams] = useQueryParams()
	// The selected span and tab live in the URL, so a reload or a shared link reopens them.
	const selectedSpanId = query.get("spanId") || undefined
	const rawView = query.get("view")
	const view = isTraceView(rawView) ? rawView : undefined
	const selectedSpan = useMemo(
		() => (selectedSpanId && trace.data ? findSpanNode(trace.data.rootSpans, selectedSpanId) : undefined),
		[selectedSpanId, trace.data],
	)
	// The first real root: an orphan's synthetic "missing" parent can sort ahead of it.
	const rootSpan = trace.data?.rootSpans.find((span) => !span.isMissing) ?? trace.data?.rootSpans[0]
	const hasError = useMemo(() => (trace.data ? traceHasError(trace.data.spans) : false), [trace.data])

	return (
		<div
			className="flex h-full flex-col"
			onKeyDown={(e) => {
				// Escape closes the span panel; a nested sheet or popover that handled it first wins.
				if (e.key === "Escape" && selectedSpan && !e.defaultPrevented) setParams({ spanId: null })
			}}
		>
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="shrink-0 gap-1.5">
					<ArrowLeftIcon />
					{backLabel}
				</Button>
				<div className="min-w-0 flex-1 text-sm font-semibold">
					{rootSpan ? (
						getHttpInfo(rootSpan) ? (
							<HttpSpanLabel
								spanName={rootSpan.spanName}
								spanAttributes={rootSpan.spanAttributes}
								spanKind={rootSpan.spanKind}
								className="min-w-0 gap-3"
							/>
						) : (
							<span className="block truncate" title={rootSpan.spanName}>
								{rootSpan.spanName}
							</span>
						)
					) : null}
				</div>
				<RefreshButton className="shrink-0" since={trace.dataUpdatedAt} />
			</div>

			<div className="min-h-0 flex-1">
				{trace.isPending ? (
					<TraceDetailLoading />
				) : trace.isError ? (
					<ErrorState label="trace" error={trace.error} onRetry={() => trace.refetch()} />
				) : trace.data.spans.length === 0 ? (
					<EmptyState
						title="Trace not found"
						hint="It may be outside the store's retention, or its spans have not arrived yet."
						action={<TraceIdBadge traceId={traceId} size="default" className="text-xs" />}
					/>
				) : (
					<div className="flex h-full min-h-0">
						<div className="flex min-w-0 flex-1 flex-col">
							<div className="shrink-0 border-b px-4 py-3">
								<TraceAnatomyStrip
									rootSpans={trace.data.rootSpans}
									spanCount={trace.data.spans.length}
									totalDurationMs={trace.data.totalDurationMs}
									traceId={traceId}
									hasError={hasError}
									httpStatusCode={rootSpan ? getHttpInfo(rootSpan)?.statusCode : undefined}
									deploymentEnv={
										rootSpan?.resourceAttributes["deployment.environment.name"] ||
										rootSpan?.resourceAttributes["deployment.environment"]
									}
								/>
							</div>
							<div className="min-h-0 flex-1">
								<TraceViewTabs
									rootSpans={trace.data.rootSpans}
									spans={trace.data.spans}
									totalDurationMs={trace.data.totalDurationMs}
									traceStartTime={trace.data.traceStartTime}
									services={trace.data.services}
									selectedSpanId={selectedSpan?.spanId}
									onSelectSpan={(span) => setParams({ spanId: span.spanId })}
									view={view ?? "timeline"}
									onViewChange={(next) =>
										setParams({ view: next === "timeline" ? null : next })
									}
								/>
							</div>
						</div>
						{selectedSpan ? (
							<SpanDetailPanel
								span={selectedSpan}
								traceStartTime={trace.data.traceStartTime}
								totalDurationMs={trace.data.totalDurationMs}
								onClose={() => setParams({ spanId: null })}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}
