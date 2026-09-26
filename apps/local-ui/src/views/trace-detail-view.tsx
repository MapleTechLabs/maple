import { useMemo } from "react"
import { isTraceView, TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import type { SpanNode } from "@maple/ui/lib/types"
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

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					{backLabel}
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>
					{traceId}
				</span>
				<RefreshButton className="ml-auto" since={trace.dataUpdatedAt} />
			</div>

			<div className="min-h-0 flex-1">
				{trace.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : trace.isError ? (
					<ErrorState label="trace" error={trace.error} onRetry={() => trace.refetch()} />
				) : trace.data.spans.length === 0 ? (
					<EmptyState
						title="No spans found for this trace"
						hint="It may be outside the store's retention, or its spans have not arrived yet."
					/>
				) : (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1">
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
						{selectedSpan ? (
							<SpanDetailPanel
								span={selectedSpan}
								onClose={() => setParams({ spanId: null })}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}
