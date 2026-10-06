import { Link } from "@tanstack/react-router"
import type { ErrorIssueSampleTrace } from "@maple/domain/http"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { RelativeTime } from "@/components/common/relative-time"
import { ServiceDot } from "@maple/ui/components/service-dot"

interface IssueOccurrencesTableProps {
	traces: ReadonlyArray<ErrorIssueSampleTrace>
}

export function IssueOccurrencesTable({ traces }: IssueOccurrencesTableProps) {
	if (traces.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>No samples in this window</EmptyTitle>
					<EmptyDescription>
						This fingerprint was not seen in the selected range. Widen the time range to find
						traces to open.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Time</TableHead>
					<TableHead>Service</TableHead>
					<TableHead>Message</TableHead>
					<TableHead>Trace</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{traces.map((trace) => (
					<TableRow key={`${trace.traceId}-${trace.spanId}`}>
						<TableCell className="tabular-nums text-muted-foreground">
							<RelativeTime value={trace.timestamp} tooltip="title" />
						</TableCell>
						<TableCell>
							<span className="inline-flex items-center gap-1.5">
								<ServiceDot serviceName={trace.serviceName} size="sm" />
								<span>{trace.serviceName}</span>
							</span>
						</TableCell>
						<TableCell className="max-w-sm truncate">{trace.exceptionMessage}</TableCell>
						<TableCell>
							<Link
								to="/traces/$traceId"
								params={{ traceId: trace.traceId }}
								search={{ t: trace.timestamp }}
								className={cn(
									"inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5",
									"font-mono text-2xs text-muted-foreground tabular-nums",
									"transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
								)}
							>
								<TruncatedId value={trace.traceId} length={12} ellipsis />
							</Link>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
