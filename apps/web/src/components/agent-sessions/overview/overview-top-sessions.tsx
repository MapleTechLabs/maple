import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { ExternalLinkIcon } from "@/components/icons"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatOverviewCount, formatOverviewDuration } from "@/lib/agent-sessions/overview-analytics"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import { sessionLinkWindow } from "@/lib/agent-sessions/session-window"
import type { AgentSessionsLinkSearch } from "@/lib/agent-sessions/overview-search"
import {
	OVERVIEW_TOP_SESSION_TABS,
	type OverviewTopSessionTab,
} from "@/lib/agent-sessions/use-agent-overview"

const TAB_LABEL = {
	cost: "most expensive",
	duration: "longest",
	errored: "errored",
} satisfies Record<OverviewTopSessionTab, string>

/** A lane: its header label, and the width and shedding rule its cells share. */
const COLUMNS = [
	{ label: "Agent", className: "w-[130px] @max-[760px]/table:hidden" },
	{ label: "Model", className: "w-[150px] @max-[900px]/table:hidden" },
	{ label: "Service", className: "w-[110px] @max-[1040px]/table:hidden" },
	{ label: "Cost", className: "w-[78px] text-right" },
	{ label: "Tokens", className: "w-[78px] text-right" },
	{ label: "LLM", className: "w-[56px] text-right @max-[620px]/table:hidden" },
	{ label: "Tools", className: "w-[56px] text-right @max-[620px]/table:hidden" },
	{ label: "Errors", className: "w-[64px] text-right" },
	{ label: "Duration", className: "w-[82px] text-right" },
	{ label: "Started", className: "w-[96px] text-right @max-[680px]/table:hidden" },
] as const

export interface OverviewTopSessionsProps {
	sessions: Record<OverviewTopSessionTab, ReadonlyArray<AgentSessionRow>>
	/** Sessions in the window that failed — what the Errored tab is a sample of. */
	erroredCount: number
	/** The board's filters, as the Sessions list takes them. */
	sessionsSearch: AgentSessionsLinkSearch
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
	const { effectiveTimezone } = useTimezonePreference()
	const [active, setActive] = useState<OverviewTopSessionTab>("cost")
	const rows = sessions[active]

	return (
		<section className={cn("transition-opacity", waiting && "opacity-60")}>
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pt-4 pb-3">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
					<h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em] text-foreground">
						Top sessions
					</h2>
					<span className="font-mono text-[11.5px] text-muted-foreground">
						the concrete examples behind the trends above
					</span>
				</div>

				<div className="flex shrink-0 flex-wrap items-center gap-1">
					{OVERVIEW_TOP_SESSION_TABS.map((tab) => (
						<button
							key={tab}
							type="button"
							aria-pressed={tab === active}
							onClick={() => setActive(tab)}
							className={cn(
								"inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11.5px] transition-colors",
								tab === active
									? "border-primary/40 bg-primary/10 text-primary"
									: "border-border text-muted-foreground hover:text-foreground",
							)}
						>
							{TAB_LABEL[tab]}
							{tab === "errored" ? (
								<span className="tabular-nums opacity-70">
									{formatOverviewCount(erroredCount)}
								</span>
							) : null}
						</button>
					))}
					<Link
						to="/agent-sessions"
						search={sessionsSearch}
						className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
					>
						Open in Sessions
						<ExternalLinkIcon size={10} aria-hidden />
					</Link>
				</div>
			</div>

			{rows.length === 0 ? (
				<p className="px-6 pb-6 font-mono text-[11.5px] text-muted-foreground/70">
					No sessions match this scope.
				</p>
			) : (
				<div className="@container/table px-6 pb-4">
					<div className="flex h-[28px] items-center border-b border-border">
						<span className={cn(HEAD, "min-w-0 flex-1")}>Session</span>
						{COLUMNS.map((column) => (
							<span key={column.label} className={cn(HEAD, "shrink-0", column.className)}>
								{column.label}
							</span>
						))}
						<span className="w-[40px] shrink-0" />
					</div>

					{rows.map((row) => (
						<div
							key={row.sessionId}
							className="flex h-[38px] items-center border-b border-border/40"
						>
							<Link
								to="/agent-sessions/$sessionId"
								params={{ sessionId: row.sessionId }}
								// The session's own bounds, so the detail page reads
								// straight from them instead of scanning the board's window.
								search={sessionLinkWindow(row)}
								className="min-w-0 flex-1 truncate pr-3 font-mono text-[12.5px] text-primary underline-offset-2 hover:underline"
							>
								{row.sessionId}
							</Link>
							<Cell className={COLUMNS[0].className} tone="text-foreground">
								{row.firstAgentName || "—"}
							</Cell>
							<Cell className={COLUMNS[1].className}>{row.models[0] ?? "—"}</Cell>
							<Cell className={COLUMNS[2].className} tone="text-muted-foreground/70">
								{row.serviceNames[0] ?? "—"}
							</Cell>
							<Cell className={COLUMNS[3].className} tone="text-foreground">
								{formatCost(row.cost)}
							</Cell>
							<Cell className={COLUMNS[4].className}>{formatNumber(row.totalTokens)}</Cell>
							<Cell className={COLUMNS[5].className}>{formatOverviewCount(row.llmCalls)}</Cell>
							<Cell className={COLUMNS[6].className}>{formatOverviewCount(row.toolCalls)}</Cell>
							<Cell
								className={COLUMNS[7].className}
								tone={
									row.errorSpanCount > 0
										? "text-[var(--severity-error)]"
										: "text-muted-foreground/50"
								}
							>
								{formatOverviewCount(row.errorSpanCount)}
							</Cell>
							<Cell className={COLUMNS[8].className} tone="text-foreground">
								{formatOverviewDuration(row.durationMs)}
							</Cell>
							<Cell className={COLUMNS[9].className} tone="text-muted-foreground/70">
								{/* The Sessions list's own reading: relative inside the week,
								    an absolute date once "23d ago" stops being the easier one. */}
								{formatRelativeTimeOrDate(row.startTime, undefined, effectiveTimezone)}
							</Cell>
							<span className="flex w-[40px] shrink-0 justify-end">
								<ExternalLinkIcon
									size={12}
									className="text-muted-foreground/40"
									aria-hidden
								/>
							</span>
						</div>
					))}

					<p className="flex h-[34px] items-center gap-2 font-mono text-[11px]">
						<span className="text-muted-foreground">
							{active === "errored"
								? `${rows.length} of ${formatOverviewCount(erroredCount)} errored sessions`
								: `${rows.length} sessions`}
						</span>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span className="min-w-0 truncate text-muted-foreground/60">
							opening a session lands on its Trace view
						</span>
					</p>
				</div>
			)}
		</section>
	)
}

const HEAD = "font-mono text-[10.5px] leading-[14px] tracking-[0.06em] text-muted-foreground/60 uppercase"

function Cell({
	className,
	tone = "text-muted-foreground",
	children,
}: {
	className: string
	tone?: string
	children: React.ReactNode
}) {
	return (
		<span
			className={cn("shrink-0 truncate font-mono text-[12px] leading-4 tabular-nums", className, tone)}
		>
			{children}
		</span>
	)
}
