import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getSessionTranscriptResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useReplayPlayer } from "./replay-player-context"
import { parseChTimestampMs } from "./replay-timeline"

type EventRow = {
	readonly timestamp: string
	readonly type: string
	readonly url: string
	readonly traceId: string
	readonly level: string
	readonly message: string
	readonly targetSelector: string
	readonly targetText: string
	readonly netMethod: string
	readonly netUrl: string
	readonly netStatus: number
	readonly netDurationMs: number
	readonly errorStack: string
}

type Tab = "console" | "network" | "error"

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
	{ id: "console", label: "Console" },
	{ id: "network", label: "Network" },
	{ id: "error", label: "Errors" },
]

/**
 * Console / Network / Errors panel for a session, backed by the distilled
 * `session_events` stream. Each row seeks the player to its moment; network and
 * error rows with a trace id link through to the backend trace.
 */
export function SessionEventsPanel({ sessionId }: { sessionId: string }) {
	const result = useAtomValue(getSessionTranscriptResultAtom({ data: { sessionId } }))
	const [tab, setTab] = React.useState<Tab>("console")
	const { timeline, recordingStartEpochMs, realTotalMs, seekDisplay } = useReplayPlayer()

	const seekTo = React.useCallback(
		(ts: string) => {
			const epoch = parseChTimestampMs(ts)
			if (Number.isNaN(epoch)) return
			const realOffset = Math.max(0, Math.min(epoch - recordingStartEpochMs, realTotalMs))
			seekDisplay(timeline.toDisplay(realOffset))
		},
		[recordingStartEpochMs, realTotalMs, seekDisplay, timeline],
	)

	return (
		<section className="rounded-xl border border-border">
			{Result.builder(result)
				.onInitial(() => <Skeleton className="m-3 h-40 rounded-lg" />)
				.onError(() => (
					<div className="p-6 text-center text-sm text-muted-foreground">
						Couldn't load session events.
					</div>
				))
				.onSuccess((data) => {
					const events = data.data as ReadonlyArray<EventRow>
					const counts = {
						console: events.filter((e) => e.type === "console").length,
						network: events.filter((e) => e.type === "network").length,
						error: events.filter((e) => e.type === "error").length,
					}
					const rows = events.filter((e) => e.type === tab)
					return (
						<>
							<div className="flex border-b border-border">
								{TABS.map((t) => (
									<button
										key={t.id}
										type="button"
										onClick={() => setTab(t.id)}
										className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-colors ${
											tab === t.id
												? "border-b-2 border-foreground text-foreground"
												: "text-muted-foreground hover:text-foreground"
										}`}
									>
										{t.label}
										<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
											{counts[t.id]}
										</span>
									</button>
								))}
							</div>
							{rows.length === 0 ? (
								<div className="p-6 text-center text-sm text-muted-foreground">
									No {tab} events in this session.
								</div>
							) : (
								<ul className="max-h-80 divide-y divide-border overflow-y-auto font-mono text-xs">
									{rows.map((ev, i) => (
										<EventLine key={i} ev={ev} onSeek={() => seekTo(ev.timestamp)} />
									))}
								</ul>
							)}
						</>
					)
				})
				.orElse(() => <Skeleton className="m-3 h-40 rounded-lg" />)}
		</section>
	)
}

function timeOf(ts: string): string {
	const part = ts.split(" ")[1] ?? ts
	return part.slice(0, 12)
}

function statusTone(status: number): string {
	if (status >= 500 || status === 0) return "text-destructive"
	if (status >= 400) return "text-warning-foreground"
	return "text-success-foreground"
}

function EventLine({ ev, onSeek }: { ev: EventRow; onSeek: () => void }) {
	return (
		<li className="flex items-start gap-3 px-3 py-2 hover:bg-muted/50">
			<button
				type="button"
				onClick={onSeek}
				className="shrink-0 tabular-nums text-muted-foreground hover:text-foreground"
				title="Seek replay to this moment"
			>
				{timeOf(ev.timestamp)}
			</button>
			<div className="min-w-0 flex-1">
				{ev.type === "console" && (
					<span className={ev.level === "error" || ev.level === "warn" ? "text-warning-foreground" : ""}>
						<span className="mr-1.5 uppercase opacity-60">{ev.level || "log"}</span>
						{ev.message}
					</span>
				)}
				{ev.type === "network" && (
					<span className="flex items-center gap-2">
						<span className="opacity-70">{ev.netMethod}</span>
						<span className={`font-semibold ${statusTone(ev.netStatus)}`}>{ev.netStatus || "ERR"}</span>
						<span className="truncate">{ev.netUrl}</span>
						<span className="ml-auto shrink-0 opacity-60">{ev.netDurationMs}ms</span>
					</span>
				)}
				{ev.type === "error" && (
					<span className="text-destructive">
						{ev.message}
						{ev.errorStack && (
							<span className="mt-0.5 block whitespace-pre-wrap text-[11px] opacity-70">
								{ev.errorStack.split("\n").slice(0, 3).join("\n")}
							</span>
						)}
					</span>
				)}
			</div>
			{ev.traceId && (
				<Link
					to="/traces/$traceId"
					params={{ traceId: ev.traceId }}
					className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					title="Open backend trace"
				>
					trace
				</Link>
			)}
		</li>
	)
}
