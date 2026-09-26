import * as React from "react"
import { MenuIcon, FireIcon, NetworkNodesIcon } from "../icons"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs"
import { SpanHierarchy } from "./span-hierarchy"
import { TraceTimeline } from "./trace-timeline"
import { TraceFlowView } from "./flow-view"
import { TraceViewProvider } from "./trace-view-context"
import { DEFAULT_COLOR_BY, type ColorByField } from "./color-by"
import type { SpanNode, Span } from "../../lib/types"

export type TraceView = "waterfall" | "timeline" | "flow"

const TRACE_VIEWS: ReadonlyArray<TraceView> = ["waterfall", "timeline", "flow"]

export const isTraceView = (value: unknown): value is TraceView => TRACE_VIEWS.some((view) => view === value)

interface TraceViewTabsProps {
	rootSpans: SpanNode[]
	spans: Span[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	selectedSpanId?: string
	onSelectSpan?: (span: SpanNode) => void
	/** Controlled active tab. Omit to let the tabs own it, starting on the timeline. */
	view?: TraceView
	onViewChange?: (view: TraceView) => void
}

export function TraceViewTabs({
	rootSpans,
	spans: _spans,
	totalDurationMs,
	traceStartTime,
	services,
	selectedSpanId,
	onSelectSpan,
	view,
	onViewChange,
}: TraceViewTabsProps) {
	// _spans is reserved for future Flow view implementation
	const [colorBy, setColorBy] = React.useState<ColorByField>(DEFAULT_COLOR_BY)

	return (
		<TraceViewProvider
			rootSpans={rootSpans}
			totalDurationMs={totalDurationMs}
			traceStartTime={traceStartTime}
			services={services}
			selectedSpanId={selectedSpanId}
			onSelectSpan={onSelectSpan}
			colorBy={colorBy}
			setColorBy={setColorBy}
		>
			<Tabs
				{...(view === undefined ? { defaultValue: "timeline" } : { value: view })}
				onValueChange={(next) => {
					if (isTraceView(next)) onViewChange?.(next)
				}}
				className="flex flex-col h-full"
			>
				<TabsList variant="underline" className="shrink-0">
					<TabsTrigger value="waterfall">
						<MenuIcon size={14} />
						Waterfall
					</TabsTrigger>
					<TabsTrigger value="timeline">
						<FireIcon size={14} />
						Timeline
					</TabsTrigger>
					<TabsTrigger value="flow">
						<NetworkNodesIcon size={14} />
						Flow
					</TabsTrigger>
				</TabsList>

				<TabsContent value="waterfall" className="flex-1 min-h-0">
					<SpanHierarchy />
				</TabsContent>

				<TabsContent value="timeline" className="flex-1 min-h-0">
					<TraceTimeline />
				</TabsContent>

				<TabsContent value="flow" className="flex-1 min-h-0">
					<TraceFlowView
						rootSpans={rootSpans}
						totalDurationMs={totalDurationMs}
						traceStartTime={traceStartTime}
						services={services}
						selectedSpanId={selectedSpanId}
						onSelectSpan={onSelectSpan}
					/>
				</TabsContent>
			</Tabs>
		</TraceViewProvider>
	)
}
