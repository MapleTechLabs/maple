import { useState } from "react"

import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import type { SpanNode } from "@maple/ui/lib/types"

import { SpanEventsSection } from "@/components/traces/span-events-section"
import {
	TIMELINE_LAB_TRACE as DETAIL,
	TIMELINE_LAB_EVENTS,
	TIMELINE_LAB_MARKERS,
} from "@/lab/timeline-fixture"

export function TimelineLab() {
	const [selected, setSelected] = useState<SpanNode | undefined>(undefined)
	const events = selected ? TIMELINE_LAB_EVENTS.get(selected.spanId) : undefined
	return (
		<div className="flex h-screen gap-4 p-4">
			<div className="min-w-0 flex-1">
				<TraceViewTabs
					rootSpans={DETAIL.rootSpans}
					spans={DETAIL.spans}
					totalDurationMs={DETAIL.totalDurationMs}
					traceStartTime={DETAIL.traceStartTime}
					services={DETAIL.services}
					spanEvents={TIMELINE_LAB_MARKERS}
					selectedSpanId={selected?.spanId}
					onSelectSpan={setSelected}
				/>
			</div>
			{events && (
				<aside className="w-96 shrink-0 overflow-y-auto">
					<SpanEventsSection events={events} />
				</aside>
			)}
		</div>
	)
}
