import * as React from "react"
import { Schema } from "effect"
import { TraceId } from "@maple/domain/http"
import { cn } from "@maple/ui/utils"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getSessionTraceSummariesResultAtom,
	getSpanHierarchyResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import {
	type ActionKind,
	type DisplayMarker,
	useReplayPlayer,
	type ReplayPlayerContextValue,
} from "./replay-player-context"
import { spanDisplayRange } from "./replay-timeline"
import {
	ChevronRightIcon,
	ChevronDownIcon,
	MediaPlayIcon,
	MediaPauseIcon,
	ArrowPathIcon,
	PulseIcon,
} from "@/components/icons"

// ---------------------------------------------------------------------------
// Replay editor timeline
//
// A video-editor-style strip below the recording: a transport row, a time
// ruler, the recording's activity track (the master scrub track), and a
// "Traces" track where each correlated backend trace is a bar on the same time
// axis. Expanding a trace fetches its spans on demand and lays them out as a
// mini waterfall. A single playhead spans every track; clicking a trace/span
// seeks the recording to that moment.
//
// All rows reserve the same `LANE_GUTTER` on the left, so percentage-based
// time positions line up across tracks and with the playhead overlay.
// ---------------------------------------------------------------------------

/** Fixed left gutter (label column) shared by every row. Matches `left-36`. */
const LANE_GUTTER = "w-36"

/** Marker dot colour by action kind (mirrors the old scrubber). */
const MARKER_STYLES: Record<ActionKind, string> = {
	click: "bg-amber-400",
	input: "bg-sky-400",
	scroll: "bg-violet-400",
	nav: "bg-emerald-400",
}

function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function pct(ms: number, totalMs: number): number {
	if (totalMs <= 0) return 0
	return Math.min(100, Math.max(0, (ms / totalMs) * 100))
}

interface SessionTraceSummary {
	readonly traceId: string
	readonly startTime: string
	readonly durationMs: number
	readonly rootSpanName: string
	readonly rootServiceName: string
	readonly spanCount: number
	readonly hasError: number
}

export function ReplayEditorTimeline({ traceIds }: { traceIds: ReadonlyArray<string> }) {
	const player = useReplayPlayer()

	return (
		<section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
			<TransportRow player={player} />
			{/* Shared time region. The playhead overlays every track; scrubbing is
			    driven from the activity track (the master scrub track). */}
			<div className="relative">
				<TimeRuler totalMs={player.displayTotalMs} />
				<ActivityTrack player={player} />
				<TracesTrack traceIds={traceIds} player={player} />
				<Playhead player={player} />
			</div>
		</section>
	)
}

// --- Transport ------------------------------------------------------------

function TransportRow({ player }: { player: ReplayPlayerContextValue }) {
	const { isPlaying, finished, displayCurrentMs, displayTotalMs } = player
	// Slim header: the speed / skip-idle / fullscreen controls live in the player
	// above. This strip just labels the timeline and mirrors play + clock so the
	// view is usable on its own while you're scanning traces.
	return (
		<div className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
			<button
				type="button"
				onClick={player.togglePlay}
				aria-label={finished ? "Replay" : isPlaying ? "Pause" : "Play"}
				className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95"
			>
				{finished ? (
					<ArrowPathIcon className="size-3.5" />
				) : isPlaying ? (
					<MediaPauseIcon className="size-3.5" />
				) : (
					<MediaPlayIcon className="size-3.5 translate-x-px" />
				)}
			</button>

			<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Timeline
			</span>

			<div className="ml-auto flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
				<span className="text-foreground">{formatClock(displayCurrentMs)}</span>
				<span className="opacity-50">/</span>
				<span>{formatClock(displayTotalMs)}</span>
			</div>
		</div>
	)
}

// --- Ruler ----------------------------------------------------------------

function TimeRuler({ totalMs }: { totalMs: number }) {
	const ticks = React.useMemo(() => {
		const count = 6
		return Array.from({ length: count + 1 }, (_, i) => (totalMs * i) / count)
	}, [totalMs])
	return (
		<div className="flex items-stretch border-b border-border/60 bg-muted/10">
			<div className={cn(LANE_GUTTER, "shrink-0 border-r border-border/60")} />
			<div className="relative h-5 flex-1">
				{ticks.map((ms, i) => (
					<span
						key={i}
						className={cn(
							"absolute top-0 -translate-x-1/2 px-1 font-mono text-[10px] tabular-nums text-muted-foreground",
							i === 0 && "translate-x-0",
							i === ticks.length - 1 && "-translate-x-full",
						)}
						style={{ left: `${pct(ms, totalMs)}%` }}
					>
						{formatClock(ms)}
					</span>
				))}
			</div>
		</div>
	)
}

// --- Activity track (master scrub) ----------------------------------------

function ActivityTrack({ player }: { player: ReplayPlayerContextValue }) {
	const { displayTotalMs, markers, idleBands } = player
	const laneRef = React.useRef<HTMLDivElement | null>(null)
	const [dragging, setDragging] = React.useState(false)

	const msFromClientX = React.useCallback(
		(clientX: number) => {
			const el = laneRef.current
			if (!el) return 0
			const rect = el.getBoundingClientRect()
			const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
			return Math.max(0, Math.min(1, ratio)) * displayTotalMs
		},
		[displayTotalMs],
	)

	return (
		<div className="flex items-stretch border-b border-border/60">
			<div
				className={cn(
					LANE_GUTTER,
					"flex shrink-0 items-center gap-1.5 border-r border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground",
				)}
			>
				<PulseIcon className="size-3.5 opacity-70" />
				Activity
			</div>
			<div
				ref={laneRef}
				role="slider"
				aria-label="Seek"
				aria-valuemin={0}
				aria-valuemax={Math.round(displayTotalMs)}
				aria-valuenow={Math.round(player.displayCurrentMs)}
				tabIndex={0}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId)
					setDragging(true)
					player.seekDisplay(msFromClientX(e.clientX))
				}}
				onPointerMove={(e) => {
					if (dragging) player.seekDisplay(msFromClientX(e.clientX))
				}}
				onPointerUp={(e) => {
					e.currentTarget.releasePointerCapture(e.pointerId)
					setDragging(false)
				}}
				className="group relative h-9 flex-1 cursor-pointer touch-none select-none"
			>
				{/* Track bar */}
				<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
					{idleBands.map((band, i) => {
						const leftPct = pct(band.start, displayTotalMs)
						const widthPct = Math.max(0, pct(band.end, displayTotalMs) - leftPct)
						return (
							<span
								key={`idle-${band.start}-${i}`}
								className="absolute inset-y-0 bg-foreground/25"
								style={{
									left: `${leftPct}%`,
									width: `${widthPct}%`,
									minWidth: 3,
									backgroundImage:
										"repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,0.18) 2px 4px)",
								}}
								title="Idle"
							/>
						)
					})}
					<div
						className="relative h-full rounded-full bg-primary"
						style={{ width: `${pct(player.displayCurrentMs, displayTotalMs)}%` }}
					/>
				</div>
				{/* Action markers */}
				{markers.map((m: DisplayMarker, i) => (
					<span
						key={`${m.kind}-${m.ms}-${i}`}
						className={cn(
							"absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-card",
							MARKER_STYLES[m.kind],
						)}
						style={{ left: `${pct(m.ms, displayTotalMs)}%` }}
						title={m.kind}
					/>
				))}
			</div>
		</div>
	)
}

// --- Traces track ---------------------------------------------------------

function TracesTrack({
	traceIds,
	player,
}: {
	traceIds: ReadonlyArray<string>
	player: ReplayPlayerContextValue
}) {
	const result = useAtomValue(getSessionTraceSummariesResultAtom({ data: { traceIds } }))

	const header = (count: number | null) => (
		<div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			<PulseIcon className="size-3.5" />
			Traces
			{count != null && count > 0 && (
				<span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] tabular-nums text-primary">
					{count}
				</span>
			)}
		</div>
	)

	if (traceIds.length === 0) {
		return (
			<div>
				{header(0)}
				<p className="px-3 py-4 text-xs leading-relaxed text-muted-foreground">
					No backend traces were linked to this session. Correlation populates automatically when
					the page is instrumented with <span className="font-mono">@maple/browser</span> tracing.
				</p>
			</div>
		)
	}

	return (
		<div>
			{Result.builder(result)
				.onInitial(() => (
					<>
						{header(null)}
						<div className="space-y-2 px-3 py-3">
							<div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
							<div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
						</div>
					</>
				))
				.onError(() => (
					<>
						{header(null)}
						<p className="px-3 py-4 text-xs text-destructive">Couldn’t load correlated traces.</p>
					</>
				))
				.onSuccess((res) => {
					const summaries = res.data as ReadonlyArray<SessionTraceSummary>
					return (
						<>
							{header(summaries.length)}
							{summaries.length === 0 ? (
								<p className="px-3 py-4 text-xs text-muted-foreground">
									Linked traces aren’t available yet — they may still be ingesting.
								</p>
							) : (
								<ul>
									{summaries.map((s) => (
										<TraceRow key={s.traceId} summary={s} player={player} />
									))}
								</ul>
							)}
						</>
					)
				})
				.render()}
		</div>
	)
}

function TraceRow({
	summary,
	player,
}: {
	summary: SessionTraceSummary
	player: ReplayPlayerContextValue
}) {
	const [expanded, setExpanded] = React.useState(false)
	const range = spanDisplayRange({
		spanStartIso: summary.startTime,
		durationMs: summary.durationMs,
		recordingStartEpochMs: player.recordingStartEpochMs,
		realTotalMs: player.realTotalMs,
		timeline: player.timeline,
	})
	const isError = summary.hasError > 0

	return (
		<li className="border-b border-border/40 last:border-b-0">
			<div className="flex items-stretch">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className={cn(
						LANE_GUTTER,
						"flex shrink-0 items-center gap-1 border-r border-border/60 px-2 py-2 text-left text-xs transition-colors hover:bg-muted/50",
					)}
					title={`${summary.rootServiceName} · ${summary.spanCount} spans`}
				>
					{expanded ? (
						<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
					)}
					<span className="min-w-0 truncate">
						<span className="block truncate font-medium text-foreground">
							{summary.rootSpanName || "trace"}
						</span>
						<span className="block truncate font-mono text-[10px] text-muted-foreground">
							{summary.rootServiceName}
						</span>
					</span>
				</button>
				<button
					type="button"
					onClick={() => player.seekDisplay(range.displayStartMs)}
					title={`${summary.rootSpanName} — fired at ${formatClock(range.displayStartMs)} · ${Math.round(
						summary.durationMs,
					)}ms${range.outOfRange ? " · outside recording" : ""}`}
					className="relative h-11 flex-1 cursor-pointer"
				>
					<TraceBar
						leftPct={pct(range.displayStartMs, player.displayTotalMs)}
						widthPct={Math.max(
							0.6,
							pct(range.displayEndMs, player.displayTotalMs) -
								pct(range.displayStartMs, player.displayTotalMs),
						)}
						isError={isError}
						outOfRange={range.outOfRange}
						label={`${Math.round(summary.durationMs)}ms`}
					/>
				</button>
			</div>
			{expanded && (
				<TraceSpanLane traceId={summary.traceId} timestamp={summary.startTime} player={player} />
			)}
		</li>
	)
}

function TraceBar({
	leftPct,
	widthPct,
	isError,
	outOfRange,
	label,
}: {
	leftPct: number
	widthPct: number
	isError: boolean
	outOfRange: boolean
	label: string
}) {
	return (
		<span
			className={cn(
				"absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-[10px] font-medium text-white ring-1 ring-inset transition-[filter] hover:brightness-110",
				isError ? "bg-destructive ring-destructive/40" : "bg-primary ring-primary/40",
				outOfRange && "opacity-60 ring-dashed",
			)}
			style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 6 }}
		>
			<span className="truncate">{label}</span>
		</span>
	)
}

// --- Span lane (lazy, on expand) ------------------------------------------

interface SpanRow {
	readonly spanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly startTime: string
	readonly durationMs: number
	readonly statusCode: string
}

function TraceSpanLane({
	traceId,
	timestamp,
	player,
}: {
	traceId: string
	timestamp: string
	player: ReplayPlayerContextValue
}) {
	// Branding the id matches how every other caller drives this atom; the query
	// only fires now because this component mounts only when the row is expanded.
	const result = useAtomValue(
		getSpanHierarchyResultAtom({
			data: { traceId: Schema.decodeSync(TraceId)(traceId), timestamp },
		}),
	)

	return Result.builder(result)
		.onInitial(() => (
			<div className="bg-muted/10 px-3 py-2">
				<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
			</div>
		))
		.onError(() => (
			<div className="bg-muted/10 px-3 py-2 text-[11px] text-destructive">
				Couldn’t load spans for this trace.
			</div>
		))
		.onSuccess((res) => {
			const spans = res.spans as ReadonlyArray<SpanRow>
			if (spans.length === 0) {
				return (
					<div className="bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground">
						No spans found for this trace.
					</div>
				)
			}
			const sorted = [...spans].sort(
				(a, b) =>
					spanOffset(a, player.recordingStartEpochMs) -
					spanOffset(b, player.recordingStartEpochMs),
			)
			return (
				<div className="max-h-56 space-y-px overflow-y-auto bg-muted/10 py-1">
					{sorted.map((span) => (
						<SpanRowItem key={span.spanId} span={span} player={player} />
					))}
				</div>
			)
		})
		.render()
}

function spanOffset(span: SpanRow, recordingStartEpochMs: number): number {
	return new Date(span.startTime.replace(" ", "T") + "Z").getTime() - recordingStartEpochMs
}

function SpanRowItem({ span, player }: { span: SpanRow; player: ReplayPlayerContextValue }) {
	const range = spanDisplayRange({
		spanStartIso: span.startTime,
		durationMs: span.durationMs,
		recordingStartEpochMs: player.recordingStartEpochMs,
		realTotalMs: player.realTotalMs,
		timeline: player.timeline,
	})
	const isError = span.statusCode === "Error"
	const leftPct = pct(range.displayStartMs, player.displayTotalMs)
	const widthPct = Math.max(0.4, pct(range.displayEndMs, player.displayTotalMs) - leftPct)

	return (
		<div className="flex items-stretch">
			<div
				className={cn(LANE_GUTTER, "shrink-0 truncate border-r border-border/40 px-2 py-1 pl-6")}
				title={`${span.serviceName} · ${span.spanName}`}
			>
				<span className="block truncate text-[10px] text-muted-foreground">{span.spanName}</span>
			</div>
			<button
				type="button"
				onClick={() => player.seekDisplay(range.displayStartMs)}
				title={`${span.spanName} — fired at ${formatClock(range.displayStartMs)} · ${Math.round(
					span.durationMs,
				)}ms${range.outOfRange ? " · outside recording" : ""}`}
				className="relative h-5 flex-1 cursor-pointer"
			>
				<span
					className={cn(
						"absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm transition-[filter] hover:brightness-110",
						isError ? "bg-destructive" : "bg-primary/70",
						range.outOfRange && "opacity-50",
					)}
					style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 4 }}
				/>
			</button>
		</div>
	)
}

// --- Playhead -------------------------------------------------------------

function Playhead({ player }: { player: ReplayPlayerContextValue }) {
	const position = pct(player.displayCurrentMs, player.displayTotalMs)
	// Overlay covers the shared time area only (right of the `w-36` gutter), so
	// `left: position%` maps to the same coordinate space as the track bars.
	return (
		<div className="pointer-events-none absolute inset-y-0 left-36 right-0">
			<div className="absolute inset-y-0 w-px bg-primary/80" style={{ left: `${position}%` }}>
				<div className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary shadow-sm" />
			</div>
		</div>
	)
}
