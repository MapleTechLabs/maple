import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { countLabel } from "@maple/ui/lib/format"
import type { SpanNode } from "@maple/ui/lib/types"
import { CircleXmarkIcon } from "@/components/icons"
import { spanHttpStatus, type TraceErrors } from "@/lib/traces/trace-errors"

/**
 * The failure up front: where the trace most likely broke and why, one click from
 * its span. Without it an error trace only says "Error" and leaves the hunt to you.
 */
export function TraceErrorCallout({
	errors,
	selectedSpanId,
	onSelectSpan,
}: {
	errors: TraceErrors
	selectedSpanId: string | undefined
	onSelectSpan: (span: SpanNode) => void
}) {
	const origin = errors.origin
	if (!origin) return null

	const httpStatus = spanHttpStatus(origin)
	const reason = origin.statusMessage || (httpStatus != null ? `HTTP ${httpStatus}` : undefined)

	return (
		<Alert variant="crit" size="sm" className="shrink-0">
			<CircleXmarkIcon />
			<AlertTitle className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
				<span className="text-severity-error">{countLabel(errors.spans.length, "failed span")}</span>
				{errors.spans.length > 1 && (
					<span className="text-muted-foreground font-normal">likely origin</span>
				)}
				<span className="flex min-w-0 items-center gap-1.5 font-mono font-normal">
					<ServiceDot serviceName={origin.serviceName} size="sm" />
					<span className="text-muted-foreground">{origin.serviceName}</span>
					<span className="truncate">{origin.spanName}</span>
				</span>
			</AlertTitle>
			{reason && (
				<AlertDescription className="min-w-0">
					<p className="line-clamp-2 font-mono text-xs [overflow-wrap:anywhere]" title={reason}>
						{reason}
					</p>
				</AlertDescription>
			)}
			<AlertAction>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={selectedSpanId === origin.spanId}
					onClick={() => onSelectSpan(origin)}
				>
					View span
				</Button>
			</AlertAction>
		</Alert>
	)
}
