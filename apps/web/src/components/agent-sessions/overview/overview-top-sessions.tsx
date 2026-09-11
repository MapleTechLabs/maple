import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeShort } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import type { AgentSessionsSearchState } from "@/components/agent-sessions/agent-sessions-filter-inputs"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import {
	formatOverviewCount,
	formatOverviewDuration,
} from "@/lib/agent-sessions/overview-analytics"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import { sessionLinkWindow } from "@/lib/agent-sessions/session-window"
import {
	OVERVIEW_TOP_SESSION_TABS,
	type OverviewTopSessionTab,
} from "@/lib/agent-sessions/use-agent-overview"

const TAB_LABEL = {
	cost: "most expensive",
	duration: "longest",
	errored: "errored",
} satisfies Record<OverviewTopSessionTab, string>

const COLUMNS = [
	"Agent",
	"Model",
	"Service",
	"Cost",
	"Tokens",
	"LLM",
	"Tools",
	"Errors",
	"Duration",
	"Started",
] as const

export interface OverviewTopSessionsProps {
	sessions: Record<OverviewTopSessionTab, ReadonlyArray<AgentSessionRow>>
	/** Sessions in the window that failed — what the Errored tab is a sample of. */
	erroredCount: number
	/** The board's filters, as the Sessions list takes them. */
	sessionsSearch: AgentSessionsSearchState
	waiting?: boolean
}

/**
 * The concrete examples behind the trends above.
 *
 * Six rows from the sessions list itself, under the board's own filters — the
 * same endpoint the list pages, so a row here and the same row there agree. The
 * link out carries the filters and drops the ranking: the list is where the
 * rest of them are.
 */
export function OverviewTopSessions({
	sessions,
	erroredCount,
	sessionsSearch,
	waiting = false,
}: OverviewTopSessionsProps) {
	const [active, setActive] = useState<OverviewTopSessionTab>("cost")
	const rows = sessions[active]

	return (
		<section className={cn("px-6 py-4", waiting && "opacity-60")}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2">
				<h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
					Top sessions
				</h2>
				<span className="font-mono text-[11.5px] text-muted-foreground">
					the concrete examples behind the trends above
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-1 pb-2">
				{OVERVIEW_TOP_SESSION_TABS.map((tab) => (
					<button
						key={tab}
						type="button"
						aria-pressed={tab === active}
						onClick={() => setActive(tab)}
						className={cn(
							"inline-flex h-[26px] items-center gap-1.5 rounded border px-2 font-mono text-[11.5px] transition-colors",
							tab === active
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{TAB_LABEL[tab]}
						{tab === "errored" ? (
							<span className="text-[10.5px] tabular-nums opacity-70">
								{formatOverviewCount(erroredCount)}
							</span>
						) : null}
					</button>
				))}
				<Link
					to="/agent-sessions"
					search={sessionsSearch}
					className="ml-auto font-mono text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Open in Sessions ↗
				</Link>
			</div>

			{rows.length === 0 ? (
				<p className="py-6 font-mono text-[11.5px] text-muted-foreground/70">
					No sessions match this scope.
				</p>
			) : (
				<table className="w-full table-auto border-collapse font-mono text-[12px]">
					<thead>
						<tr className="border-b border-border text-left">
							<th className="py-1.5 pr-3 font-normal text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80">
								Session
							</th>
							{COLUMNS.map((column) => (
								<th
									key={column}
									className="py-1.5 pl-3 text-right font-normal text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80"
								>
									{column}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.sessionId} className="border-b border-border/60">
								<td className="max-w-[240px] truncate py-1.5 pr-3">
									<Link
										to="/agent-sessions/$sessionId"
										params={{ sessionId: row.sessionId }}
										// The session's own bounds, so the detail page reads
										// straight from them instead of scanning the board's window.
										search={sessionLinkWindow(row)}
										className="text-foreground underline-offset-2 hover:underline"
									>
										{row.sessionId}
									</Link>
								</td>
								<Cell>{row.firstAgentName || "—"}</Cell>
								<Cell>{row.models[0] ?? "—"}</Cell>
								<Cell>{row.serviceNames[0] ?? "—"}</Cell>
								<Cell>{formatCost(row.cost)}</Cell>
								<Cell>{formatNumber(row.totalTokens)}</Cell>
								<Cell>{formatOverviewCount(row.llmCalls)}</Cell>
								<Cell>{formatOverviewCount(row.toolCalls)}</Cell>
								<Cell>{formatOverviewCount(row.errorSpanCount)}</Cell>
								<Cell>{formatOverviewDuration(row.durationMs)}</Cell>
								<Cell>{formatRelativeShort(row.startTime)}</Cell>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	)
}

const Cell = ({ children }: { children: React.ReactNode }) => (
	<td className="max-w-[160px] truncate py-1.5 pl-3 text-right tabular-nums text-muted-foreground">
		{children}
	</td>
)
