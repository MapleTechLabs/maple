import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"

import { ExternalLinkIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { sessionLinkWindow, sessionRowId } from "@/lib/agent-sessions/session-window"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/**
 * The sessions that ran this tool, newest first — the way back down from an
 * aggregate to something that actually happened.
 *
 * The rows come from the sessions LIST read with the tool as a filter, not from
 * a tool-shaped aggregate: a reader arriving here is choosing a session to open,
 * and what makes that choice is the session's own identity — its framework, its
 * agent, how long it ran, how much it emitted — none of which a per-tool roll-up
 * knows. Every row links to the detail page **with the tool carried in**
 * (`?tool=`), so the trace view opens already filtered to that tool's spans.
 */
export function ToolDetailSessions({
	rows,
	tool,
	capped,
	loading,
	failure,
	waiting,
}: {
	rows: ReadonlyArray<AgentSessionRow>
	tool: string
	/** The read returned a full page — there are older sessions it did not show. */
	capped: boolean
	/** The read has not answered yet — "no sessions called this" is a finding,
	 *  not a placeholder. */
	loading?: boolean
	failure?: unknown
	waiting?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()

	return (
		<section
			className="@container/panel border-b border-border px-6 pt-5 pb-6"
			aria-label={`Sessions running ${tool}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-4 pb-3">
				<div className="flex min-w-0 items-baseline gap-2.5 font-mono">
					<span className="text-[12.5px] font-medium text-foreground">
						Sessions running {tool}
					</span>
					<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
						{plural(rows.length, "session")}
					</span>
				</div>
				<Link
					to="/agent-sessions"
					// The sessions list's own param is `tools`, not `toolNames`.
					search={{ tools: [tool] }}
					className="inline-flex h-7 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 font-mono text-[11.5px] text-foreground transition-colors hover:bg-muted/50"
				>
					Open in Sessions
					<ExternalLinkIcon size={11} className="text-muted-foreground" aria-hidden />
				</Link>
			</div>

			<div className={cn("transition-opacity", waiting && "opacity-60")}>
				{failure !== undefined ? (
					<QueryErrorState
						error={failure}
						titleOverride={`Failed to load sessions running ${tool}`}
					/>
				) : loading ? (
					<div className="flex flex-col gap-1.5 py-3">
						<Skeleton className="h-[46px]" />
						<Skeleton className="h-[46px]" />
						<Skeleton className="h-[46px]" />
					</div>
				) : rows.length === 0 ? (
					<div className="px-3 py-12 text-center font-mono text-xs text-muted-foreground">
						No sessions called {tool} in the selected window.
					</div>
				) : (
					rows.map((session) => {
						const hasErrors = session.errorSpanCount > 0
						return (
							<Link
								key={session.sessionId}
								to="/agent-sessions/$sessionId"
								params={{ sessionId: session.sessionId }}
								// The session's own bounds, so the detail page reads straight
								// from these; `tool` pre-filters its span views and `view`
								// puts the reader in the one that filter is for.
								search={{ ...sessionLinkWindow(session), tool, view: "trace" }}
								className="relative flex w-full items-center gap-4 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
							>
								{hasErrors ? (
									<span
										aria-hidden
										className="absolute inset-y-0 left-0 w-[3px] bg-[var(--severity-error)]"
									/>
								) : null}

								<span className="flex w-0 min-w-0 flex-1 flex-col gap-px">
									<span
										className="truncate font-mono text-sm font-medium leading-[18px] text-foreground"
										title={session.sessionId}
									>
										{sessionRowId(session.sessionId)}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{vendorLabel(session.vendorId)}
									</span>
								</span>

								<span className="hidden w-[176px] shrink-0 truncate text-xs text-muted-foreground @min-[720px]/panel:block">
									{[session.firstAgentName, ...session.serviceNames]
										.filter((part) => part !== "")
										.join(" · ")}
								</span>

								<span className="hidden w-[216px] shrink-0 items-baseline gap-2 @min-[560px]/panel:flex">
									<span className="font-mono text-[13px] font-semibold tabular-nums text-foreground">
										{formatSessionDuration(session.durationMs)}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{plural(session.traceCount, "trace")} ·{" "}
										{plural(session.spanCount, "span")}
									</span>
								</span>

								<span className="hidden w-[140px] shrink-0 @min-[900px]/panel:flex">
									{hasErrors ? (
										<span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10 px-2 py-0.5">
											<span
												aria-hidden
												className="size-1 shrink-0 rounded-full bg-[var(--severity-error)]"
											/>
											<span className="font-mono text-2xs font-medium leading-3 text-[var(--severity-error)]">
												{plural(session.errorSpanCount, "error")}
											</span>
										</span>
									) : null}
								</span>

								<span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
									{formatRelativeTimeOrDate(session.startTime, undefined, effectiveTimezone)}
								</span>
							</Link>
						)
					})
				)}
			</div>

			{capped ? (
				<p className="px-3 pt-3 text-sm text-muted-foreground">
					Showing the {rows.length.toLocaleString()} most recent sessions — narrow the time range
					to see older ones
				</p>
			) : null}
		</section>
	)
}
