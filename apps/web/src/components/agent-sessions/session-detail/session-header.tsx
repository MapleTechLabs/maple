import type { ReactNode } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { traceSessionTraceId } from "@maple/domain/gen-ai"

import { CopyableValue } from "@/components/attributes"
import { CopyIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"

/**
 * The page's heading: what ran, when, on what — the facts a reader needs to
 * know which session this is before any view opens.
 *
 * The heading is the agent's name (or, unnamed, the framework's), never the
 * session id or the opening prompt: the id says nothing to a human, and the
 * first line of a prompt is usually a boilerplate instruction that reads as a
 * title the session doesn't deserve. The prompt is the transcript's own first
 * line and is not repeated here; the id stays as the last fact, in full, one
 * click from the clipboard.
 */
export function SessionHeader({ sessionId, summary }: { sessionId: string; summary: SessionSummary }) {
	const identity = sessionIdentity(summary)
	const VendorIcon = vendorIcon(summary.vendorIds[0] ?? "")
	// A `trace:<id>` session is one Maple synthesized from a single trace: the
	// id a reader wants in their clipboard is the trace id, not the prefix.
	const traceId = traceSessionTraceId(sessionId)

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex min-w-0 items-center gap-2">
				<VendorIcon size={18} className="shrink-0 text-muted-foreground" aria-hidden />
				<DashboardLayout.Title title={identity.heading}>{identity.heading}</DashboardLayout.Title>
				{summary.failed && <Badge variant="error">Failed</Badge>}
			</div>

			<dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
				{identity.framework !== undefined && <Fact label="Framework">{identity.framework}</Fact>}
				<Fact label="Started" title={new Date(summary.startMs).toLocaleString()}>
					{formatRelativeTimeOrDate(summary.startMs)}
				</Fact>
				<Fact label="Duration">{formatSessionDuration(summary.wallClockMs)}</Fact>
				{summary.serviceNames.length > 0 && (
					<Fact label="Service" title={summary.serviceNames.join(", ")} mono>
						{firstPlusRest(summary.serviceNames)}
					</Fact>
				)}
				<Fact label={traceId === undefined ? "Session ID" : "Trace ID"}>
					<CopyableValue
						value={traceId ?? sessionId}
						label={traceId === undefined ? "Session ID" : "Trace ID"}
						className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono"
					>
						<span className="min-w-0 truncate">{traceId ?? sessionId}</span>
						<CopyIcon size={11} className="shrink-0 text-muted-foreground" aria-hidden />
					</CopyableValue>
				</Fact>
			</dl>
		</div>
	)
}

/**
 * What to call the session. A named agent is the best name there is; without
 * one the framework stands in, and without even that the page says "Agent
 * session" rather than parroting an unidentified vendor id. The framework is
 * returned separately only when it is not already the heading.
 */
export function sessionIdentity(summary: Pick<SessionSummary, "agentNames" | "vendorIds">): {
	heading: string
	framework: string | undefined
} {
	const vendorId = summary.vendorIds[0]
	const framework = vendorId === undefined ? undefined : vendorLabel(vendorId)
	const agentName = summary.agentNames[0]
	if (agentName !== undefined) return { heading: agentName, framework }
	if (framework !== undefined && framework !== "Unidentified") {
		return { heading: `${framework} session`, framework: undefined }
	}
	return { heading: "Agent session", framework: undefined }
}

function Fact({
	label,
	title,
	mono,
	children,
}: {
	label: string
	title?: string
	mono?: boolean
	children: ReactNode
}) {
	return (
		<div className="flex min-w-0 max-w-full items-baseline gap-1.5" title={title}>
			<dt className="shrink-0 font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
				{label}
			</dt>
			<dd className={mono ? "min-w-0 truncate font-mono" : "min-w-0 truncate"}>{children}</dd>
		</div>
	)
}

/** "claude-sonnet-5 +1": the first name, the rest as a count — the full list
 *  goes in the `title`. */
function firstPlusRest(names: readonly string[]): string {
	const [first, ...rest] = names
	if (first === undefined) return ""
	return rest.length > 0 ? `${first} +${rest.length}` : first
}
