import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"

import { ColumnHead, DataTable, useTableSort } from "@/components/infra/primitives/data-table"
import { ExternalLinkIcon } from "@/components/icons"
import { ModelLabel } from "@/components/agent-sessions/model-label"
import { breadcrumbSessionId } from "@/lib/agent-sessions/session-window"
import type { DetectedModel } from "@/hooks/use-detected-models"
import { formatDurationNs, type ToolSessionRow } from "@/lib/agent-sessions/tool-analytics"

type SessionSortKey = "sessionId" | "calls" | "errors" | "avgDurationNs" | "maxDurationNs" | "startedAt"

/**
 * The sessions behind whatever the page is currently scoped to — the way back
 * down from an aggregate to the thing that actually happened.
 *
 * Every row links to the session detail page **with the tool carried in**
 * (`?tool=`), so the trace view opens already filtered to that tool's spans.
 * Landing on a 600-span waterfall and typing the tool name again is the step
 * this panel exists to remove: the reader got here by asking about one tool,
 * and the detail page should not make them ask twice.
 */
export function ToolSessionsPanel({
	rows,
	tool,
	detect,
	waiting,
}: {
	rows: ReadonlyArray<ToolSessionRow>
	/** The picked tool, carried into each link. Absent when the page is unscoped. */
	tool: string | undefined
	detect: (model: string) => DetectedModel
	waiting?: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: "calls" as SessionSortKey,
		stringKeys: ["sessionId"],
	})

	return (
		<div className="@container/panel rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5 pb-2">
				<span className="text-[11px] font-medium text-muted-foreground">Sessions</span>
				<span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
					{formatNumber(rows.length)} listed
				</span>
			</div>

			<DataTable.Root
				ariaLabel="Sessions for the current selection"
				waiting={waiting}
				maxHeight={420}
				stickySurfaceClass="bg-card"
			>
				<DataTable.Head>
					<ColumnHead<SessionSortKey>
						label="Session"
						width="w-40 shrink-0"
						sortKey="sessionId"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<SessionSortKey>
						label="Agent"
						width="w-0 flex-1 min-w-0"
						hidden="hidden @min-[560px]/panel:flex"
					/>
					<ColumnHead<SessionSortKey>
						label="Model"
						width="w-44 shrink-0"
						hidden="hidden @min-[760px]/panel:flex"
					/>
					<ColumnHead<SessionSortKey>
						label="Calls"
						width="w-14 shrink-0"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<SessionSortKey>
						label="Errors"
						width="w-14 shrink-0"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<SessionSortKey>
						label="Avg"
						width="w-16 shrink-0"
						align="right"
						sortKey="avgDurationNs"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<ColumnHead<SessionSortKey>
						label="Max"
						width="w-16 shrink-0"
						align="right"
						sortKey="maxDurationNs"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[640px]/panel:flex"
					/>
					<ColumnHead<SessionSortKey>
						label="Started"
						width="w-20 shrink-0"
						align="right"
						sortKey="startedAt"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<span className="w-10 shrink-0" aria-hidden />
				</DataTable.Head>

				{sorted.length === 0 ? (
					<DataTable.Empty>No sessions called this in the selected window.</DataTable.Empty>
				) : (
					sorted.map((row) => (
						<Link
							key={row.sessionId}
							to="/agent-sessions/$sessionId"
							params={{ sessionId: row.sessionId }}
							// `tool` pre-filters the detail page's span views; `view` puts
							// the reader in the one that filter is for.
							search={tool === undefined ? {} : { tool, view: "trace" }}
							className="group flex items-center gap-3 border-b border-border/40 px-4 py-2.5 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
						>
							<span
								className="w-40 shrink-0 truncate font-mono text-[11px]"
								title={row.sessionId}
							>
								{breadcrumbSessionId(row.sessionId)}
							</span>
							<span className="hidden w-0 min-w-0 flex-1 truncate text-[12px] @min-[560px]/panel:block">
								{row.agentName === "" ? (
									<span className="text-muted-foreground/60">—</span>
								) : (
									row.agentName
								)}
							</span>
							<span className="hidden w-44 shrink-0 text-[12px] @min-[760px]/panel:block">
								<ModelLabel detected={detect(row.model)} size={13} />
							</span>
							<span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums">
								{formatNumber(row.calls)}
							</span>
							<span
								className={cn(
									"w-14 shrink-0 text-right font-mono text-[11px] tabular-nums",
									row.errors > 0 ? "text-[var(--severity-error)]" : "text-muted-foreground/60",
								)}
							>
								{row.errors === 0 ? "—" : formatNumber(row.errors)}
							</span>
							<span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
								{formatDurationNs(row.avgDurationNs)}
							</span>
							<span className="hidden w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground @min-[640px]/panel:block">
								{formatDurationNs(row.maxDurationNs)}
							</span>
							<span className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
								{formatRelativeFrom(row.startedAt)}
							</span>
							<span className="flex w-10 shrink-0 items-center justify-end text-muted-foreground/60 transition-colors group-hover:text-foreground">
								<ExternalLinkIcon size={12} aria-hidden />
								<span className="sr-only">View session</span>
							</span>
						</Link>
					))
				)}
			</DataTable.Root>
		</div>
	)
}
