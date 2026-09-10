import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { useTableSort } from "@/components/infra/primitives/data-table"
import { CircleInfoIcon, ExternalLinkIcon } from "@/components/icons"
import { ModelLabel } from "@/components/agent-sessions/model-label"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { breadcrumbSessionId } from "@/lib/agent-sessions/session-window"
import type { DetectedModel } from "@/hooks/use-detected-models"
import { formatDurationNs, type ToolSessionRow } from "@/lib/agent-sessions/tool-analytics"

import { ROW, ROW_IDLE, Table, TableBody, TableEmpty, TableHead, Th } from "./tool-breakdown-tables"

type SessionSortKey = "sessionId" | "calls" | "errors" | "avgDurationNs" | "maxDurationNs" | "startedAt"

const SORT_LABEL = {
	sessionId: "session",
	calls: "calls",
	errors: "errors",
	avgDurationNs: "average",
	maxDurationNs: "max",
	startedAt: "start",
} satisfies Record<SessionSortKey, string>

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
	model,
	color,
	detect,
	waiting,
}: {
	rows: ReadonlyArray<ToolSessionRow>
	/** The picked tool, carried into each link. Absent when the page is unscoped. */
	tool: string | undefined
	/** The picked model, named in the heading. */
	model: string | undefined
	/** The picked tool's series colour, for the swatch beside the heading. */
	color: string | undefined
	detect: (model: string) => DetectedModel
	waiting?: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: "errors" as SessionSortKey,
		stringKeys: ["sessionId"],
	})
	const { effectiveTimezone } = useTimezonePreference()
	const startedAt = useMemo(
		() =>
			new Intl.DateTimeFormat(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
				timeZone: effectiveTimezone,
			}),
		[effectiveTimezone],
	)

	const scope = [tool, model === undefined ? undefined : detect(model).displayName].filter(
		(part): part is string => part !== undefined,
	)

	return (
		<section
			className="@container/panel border-t border-border bg-sidebar px-6 pt-5 pb-7"
			aria-label="Sessions for the current selection"
		>
			<div className="flex flex-wrap items-center justify-between gap-4 pb-1">
				<div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1 font-mono">
					<span
						aria-hidden
						className={cn("size-2 shrink-0 rounded-[2px]", color === undefined && "bg-primary")}
						style={color === undefined ? undefined : { backgroundColor: color }}
					/>
					<span className="text-[12.5px] font-medium text-foreground">
						{scope.length === 0 ? "Sessions" : `Sessions running ${scope.join(" × ")}`}
					</span>
					<span className="text-[11.5px] leading-3.5 text-muted-foreground/70">
						{formatNumber(rows.length)} session{rows.length === 1 ? "" : "s"} · sorted by{" "}
						{SORT_LABEL[sortKey ?? "errors"]}
					</span>
				</div>
				<Link
					to="/agent-sessions"
					search={{}}
					className="inline-flex h-7 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 font-mono text-[11.5px] text-foreground transition-colors hover:bg-muted/50"
				>
					Open in Sessions
					<ExternalLinkIcon size={11} className="text-muted-foreground" aria-hidden />
				</Link>
			</div>

			<div className="flex items-center gap-1.5 pt-1.5 pb-3 pl-[17px] font-mono text-[11px] leading-3.5 text-muted-foreground/70">
				<CircleInfoIcon size={11} className="shrink-0 text-muted-foreground/60" aria-hidden />
				{tool === undefined
					? "Opening a session lands on its Trace view."
					: `Opening a session lands on its Trace view, filtered to that session's ${tool} calls.`}
			</div>

			<Table>
				<TableHead>
					<Th<SessionSortKey>
						label="Session"
						width="w-[210px] shrink-0"
						sortKey="sessionId"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th label="Agent" width="w-0 flex-1 min-w-0" hidden="hidden @min-[560px]/panel:flex" />
					<Th label="Model" width="w-[150px] shrink-0" hidden="hidden @min-[760px]/panel:flex" />
					<Th<SessionSortKey>
						label="Calls"
						width="w-20 shrink-0"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<SessionSortKey>
						label="Errors"
						width="w-20 shrink-0"
						align="right"
						sortKey="errors"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<SessionSortKey>
						label="Avg"
						width="w-20 shrink-0"
						align="right"
						sortKey="avgDurationNs"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<SessionSortKey>
						label="Max"
						width="w-20 shrink-0"
						align="right"
						sortKey="maxDurationNs"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[640px]/panel:flex"
					/>
					<Th<SessionSortKey>
						label="Started"
						width="w-[132px] shrink-0"
						align="right"
						sortKey="startedAt"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<span className="w-[74px] shrink-0" aria-hidden />
				</TableHead>

				<TableBody waiting={waiting}>
					{sorted.length === 0 ? (
						<TableEmpty>No sessions called this in the selected window.</TableEmpty>
					) : (
						sorted.map((row) => (
							<Link
								key={row.sessionId}
								to="/agent-sessions/$sessionId"
								params={{ sessionId: row.sessionId }}
								// `tool` pre-filters the detail page's span views; `view` puts
								// the reader in the one that filter is for.
								search={tool === undefined ? {} : { tool, view: "trace" }}
								className={cn(ROW, ROW_IDLE, "group font-mono")}
							>
								<span
									className="w-[210px] shrink-0 truncate text-[12.5px] text-primary"
									title={row.sessionId}
								>
									{breadcrumbSessionId(row.sessionId)}
								</span>
								<span className="hidden w-0 min-w-0 flex-1 truncate text-xs text-foreground @min-[560px]/panel:block">
									{row.agentName === "" ? (
										<span className="text-muted-foreground/60">—</span>
									) : (
										row.agentName
									)}
								</span>
								<span className="hidden w-[150px] shrink-0 text-xs text-muted-foreground @min-[760px]/panel:block">
									<ModelLabel detected={detect(row.model)} size={12} />
								</span>
								<span className="w-20 shrink-0 text-right text-[12.5px] tabular-nums text-foreground">
									{formatNumber(row.calls)}
								</span>
								<span
									className={cn(
										"w-20 shrink-0 text-right text-[12.5px] tabular-nums",
										row.errors > 0
											? "text-[var(--severity-error)]"
											: "text-muted-foreground/60",
									)}
								>
									{formatNumber(row.errors)}
								</span>
								<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
									{formatDurationNs(row.avgDurationNs)}
								</span>
								<span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-foreground/80 @min-[640px]/panel:block">
									{formatDurationNs(row.maxDurationNs)}
								</span>
								<span className="w-[132px] shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground/70">
									{startedAt.format(row.startedAt)}
								</span>
								<span className="flex w-[74px] shrink-0 items-center justify-end gap-[5px] text-[11.5px] text-muted-foreground transition-colors group-hover:text-foreground">
									View
									<ExternalLinkIcon size={11} aria-hidden />
								</span>
							</Link>
						))
					)}
				</TableBody>
			</Table>

			<div className="flex h-9 items-center gap-[9px] px-2.5 font-mono text-xs">
				<span className="text-muted-foreground">
					Showing {formatNumber(rows.length)} session
					{rows.length === 1 ? "" : "s"}
				</span>
				{rows.length > 10 ? <span className="text-muted-foreground/60">scroll for more</span> : null}
			</div>
		</section>
	)
}
