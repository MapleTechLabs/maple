import { useState } from "react"
import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ArrowLeftIcon, XmarkIcon } from "@maple/ui/components/icons"
import { formatDuration } from "@maple/ui/format"
import type { SpanNode } from "@maple/ui/types"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"

interface TraceDetailViewProps {
	traceId: string
	onBack: () => void
}

export function TraceDetailView({ traceId, onBack }: TraceDetailViewProps) {
	const { data, isPending, isError, error } = useLocalTraceDetail(traceId)
	const [selectedSpan, setSelectedSpan] = useState<SpanNode | undefined>(undefined)

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Traces
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>
					{traceId}
				</span>
			</div>

			<div className="min-h-0 flex-1">
				{isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : isError ? (
					<div className="p-6 text-sm text-destructive">
						Failed to load trace: {error instanceof Error ? error.message : String(error)}
					</div>
				) : !data || data.spans.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No spans found for this trace.
					</div>
				) : (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1">
							<TraceViewTabs
								rootSpans={data.rootSpans}
								spans={data.spans}
								totalDurationMs={data.totalDurationMs}
								traceStartTime={data.traceStartTime}
								services={data.services}
								selectedSpanId={selectedSpan?.spanId}
								onSelectSpan={setSelectedSpan}
							/>
						</div>
						{selectedSpan ? (
							<SpanDetailPanel span={selectedSpan} onClose={() => setSelectedSpan(undefined)} />
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}

function SpanDetailPanel({ span, onClose }: { span: SpanNode; onClose: () => void }) {
	const attributes = Object.entries(span.spanAttributes)
	const resourceAttributes = Object.entries(span.resourceAttributes)

	return (
		<aside className="flex w-96 shrink-0 flex-col overflow-auto border-l">
			<div className="flex items-start justify-between gap-2 border-b px-4 py-3">
				<div className="min-w-0">
					<p className="truncate font-mono text-sm" title={span.spanName}>
						{span.spanName}
					</p>
					<p className="text-xs text-muted-foreground">{span.serviceName}</p>
				</div>
				<Button variant="ghost" size="icon-sm" onClick={onClose}>
					<XmarkIcon size={14} />
				</Button>
			</div>

			<dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 text-xs">
				<DetailRow label="Duration" value={formatDuration(span.durationMs)} />
				<DetailRow label="Kind" value={span.spanKind} />
				<DetailRow label="Status" value={span.statusCode} />
				<DetailRow label="Span ID" value={span.spanId} mono />
				{span.statusMessage ? <DetailRow label="Message" value={span.statusMessage} /> : null}
			</dl>

			<AttributeSection title="Span Attributes" entries={attributes} />
			<AttributeSection title="Resource Attributes" entries={resourceAttributes} />
		</aside>
	)
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="min-w-0">
			<dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
			<dd className={`truncate ${mono ? "font-mono" : ""}`} title={value}>
				{value}
			</dd>
		</div>
	)
}

function AttributeSection({ title, entries }: { title: string; entries: [string, string][] }) {
	if (entries.length === 0) return null
	return (
		<div className="border-t px-4 py-3">
			<p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
			<dl className="flex flex-col gap-1.5 text-xs">
				{entries.map(([key, value]) => (
					<div key={key} className="flex flex-col gap-0.5">
						<dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
						<dd className="break-all font-mono">{String(value)}</dd>
					</div>
				))}
			</dl>
		</div>
	)
}
