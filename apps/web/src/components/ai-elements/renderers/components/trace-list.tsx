import type { RendererComponentProps } from "./types"
import { cn } from "@maple/ui/lib/utils"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { formatDuration } from "@maple/ui/lib/format"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Badge } from "@maple/ui/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"

interface TraceListProps {
	traces: ReadonlyArray<{
		traceId: string
		rootSpanName: string
		durationMs: number
		spanCount?: number
		services: ReadonlyArray<string>
		hasError: boolean
		startTime?: string
		errorMessage?: string
	}>
	stats?: {
		p50Ms: number
		p95Ms: number
		minMs: number
		maxMs: number
	}
}

export function TraceList({ props }: RendererComponentProps<TraceListProps>) {
	const { traces, stats } = props

	return (
		<div className="space-y-1.5">
			{stats && (
				<div className="flex gap-3 text-[10px] text-muted-foreground">
					<span>
						P50: <LatencyValue ms={stats.p50Ms} scale="p50" className="text-[10px]" />
					</span>
					<span>
						P95: <LatencyValue ms={stats.p95Ms} scale="p95" className="text-[10px]" />
					</span>
					<span>Min: {formatDuration(stats.minMs)}</span>
					<span>Max: {formatDuration(stats.maxMs)}</span>
				</div>
			)}
			<div className="max-h-[300px] overflow-y-auto">
				<Table size="xs" scroll={false}>
					<TableHeader>
						<TableRow>
							<TableHead>Trace ID</TableHead>
							<TableHead>Root Span</TableHead>
							<TableHead className="text-right">Duration</TableHead>
							<TableHead className="text-right">Spans</TableHead>
							<TableHead className="pr-0">Services</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{traces.map((trace) => (
							<TableRow key={trace.traceId}>
								<TableCell className="py-1">
									<a
										href={`/traces/${trace.traceId}${trace.startTime ? `?t=${encodeURIComponent(trace.startTime)}` : ""}`}
										target="_blank"
										rel="noreferrer"
										className="font-mono text-primary hover:underline"
									>
										<TruncatedId value={trace.traceId} kind="trace" length={12} />
									</a>
									{trace.hasError && <StatusDot tone="crit" className="ml-1" />}
								</TableCell>
								<TableCell className="max-w-[160px] py-1">
									<HttpSpanLabel spanName={trace.rootSpanName} />
								</TableCell>
								<TableCell
									className={cn(
										"py-1 text-right font-mono",
										trace.durationMs > 1000 && "text-severity-warn",
										trace.durationMs > 5000 && "text-severity-error",
									)}
								>
									{formatDuration(trace.durationMs)}
								</TableCell>
								<TableCell className="py-1 text-right text-muted-foreground">
									{trace.spanCount ?? ""}
								</TableCell>
								<TableCell className="py-1 pr-0">
									<div className="flex flex-wrap gap-1">
										{trace.services.slice(0, 3).map((svc) => (
											<Badge key={svc} variant="muted" size="xs">
												{svc}
											</Badge>
										))}
										{trace.services.length > 3 && (
											<span className="text-[10px] text-muted-foreground">
												+{trace.services.length - 3}
											</span>
										)}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	)
}
