import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import { formatDuration } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import { useLocalTraces } from "../hooks/use-local-traces"

interface TraceListViewProps {
	onSelectTrace: (traceId: string) => void
}

export function TraceListView({ onSelectTrace }: TraceListViewProps) {
	const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalTraces()

	const rows = data?.pages.flat() ?? []

	if (isPending) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		)
	}

	if (isError) {
		return (
			<div className="p-6 text-sm text-destructive">
				Failed to load traces: {error instanceof Error ? error.message : String(error)}
			</div>
		)
	}

	if (rows.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
				<p className="text-sm">No traces yet</p>
				<p className="text-xs">Send OTLP spans to the local ingest endpoint to get started.</p>
			</div>
		)
	}

	return (
		<div className="flex h-full flex-col overflow-auto">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[40%]">Trace</TableHead>
						<TableHead>Service</TableHead>
						<TableHead className="text-right">Duration</TableHead>
						<TableHead className="text-right">Spans</TableHead>
						<TableHead>Time</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow
							key={row.traceId}
							className={cn("cursor-pointer", row.hasError && "bg-destructive/5")}
							onClick={() => onSelectTrace(row.traceId)}
						>
							<TableCell className="min-w-0">
								<div className="flex items-center gap-2">
									{row.hasError ? (
										<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
									) : null}
									<HttpSpanLabel
										spanName={row.rootSpanName}
										spanKind={row.rootSpanKind}
										spanAttributes={{
											"http.method": row.rootHttpMethod,
											"http.route": row.rootHttpRoute,
											"http.status_code": row.rootHttpStatusCode,
										}}
										className="min-w-0"
									/>
								</div>
							</TableCell>
							<TableCell className="text-muted-foreground">
								<div className="flex flex-wrap gap-1">
									{row.services.slice(0, 3).map((service) => (
										<Badge key={service} variant="secondary" className="font-mono text-[10px]">
											{service}
										</Badge>
									))}
									{row.services.length > 3 ? (
										<Badge variant="secondary" className="font-mono text-[10px]">
											+{row.services.length - 3}
										</Badge>
									) : null}
								</div>
							</TableCell>
							<TableCell className="text-right font-mono tabular-nums">
								{formatDuration(row.durationMicros / 1000)}
							</TableCell>
							<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
								{row.spanCount}
							</TableCell>
							<TableCell className="font-mono text-xs text-muted-foreground">
								{row.startTime}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>

			{hasNextPage ? (
				<div className="flex justify-center p-4">
					<Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
						{isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
					</Button>
				</div>
			) : null}
		</div>
	)
}
