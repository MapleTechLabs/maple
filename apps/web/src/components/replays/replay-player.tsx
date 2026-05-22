import * as React from "react"
import { Replayer } from "@rrweb/replay"
import { EventType, IncrementalSource, MouseInteractions, ReplayerEvents } from "@rrweb/types"
import "@rrweb/replay/dist/style.css"
import { cn } from "@maple/ui/utils"
import {
	GlobeIcon,
	ArrowPathIcon,
	EyeIcon,
	MediaPlayIcon,
	MediaPauseIcon,
	MaximizeIcon,
	MinimizeIcon,
} from "@/components/icons"

export interface ReplayChunkUrl {
	readonly chunkSeq: number
	readonly timestamp: string
	readonly durationMs: number
	readonly eventCount: number
	readonly byteSize: number
	readonly isCheckpoint: number
	readonly url: string
}

/** Fetch a gzipped chunk and decode it back to an array of rrweb events. */
async function fetchChunk(url: string): Promise<unknown[]> {
	const response = await fetch(url)
	if (!response.ok) throw new Error(`chunk fetch failed: ${response.status}`)
	const stream = response.body?.pipeThrough(new DecompressionStream("gzip"))
	const text = stream
		? await new Response(stream).text()
		: // Fallback: object already decompressed by the CDN/transport.
			await response.text()
	const parsed = JSON.parse(text)
	return Array.isArray(parsed) ? parsed : []
}

type PlayerState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "empty" }
	| { kind: "ready"; events: unknown[] }

/** Pretty host + path for the faux browser address bar. */
function prettyUrl(url: string | undefined): string {
	if (!url) return "about:blank"
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
	} catch {
		return url
	}
}

/**
 * Renders an rrweb session replay inside a faux-browser chrome (traffic lights
 * + address bar) so the playback reads as "what the user saw". Chunk blobs are
 * fetched from signed R2 URLs, gunzipped, concatenated in order, and driven by
 * rrweb's core `Replayer` engine — the transport bar below the surface is our
 * own (see `ReplayControls`), not rrweb-player's Svelte widget.
 */
export function ReplayPlayer({
	chunks,
	url,
}: {
	chunks: ReadonlyArray<ReplayChunkUrl>
	url?: string
}) {
	const [state, setState] = React.useState<PlayerState>({ kind: "loading" })
	const figureRef = React.useRef<HTMLElement | null>(null)
	const [isFullscreen, setIsFullscreen] = React.useState(false)

	React.useEffect(() => {
		let cancelled = false
		setState({ kind: "loading" })
		;(async () => {
			try {
				if (chunks.length === 0) {
					if (!cancelled) setState({ kind: "empty" })
					return
				}
				const ordered = [...chunks].sort((a, b) => a.chunkSeq - b.chunkSeq)
				const decoded = await Promise.all(ordered.map((c) => fetchChunk(c.url)))
				const events = decoded.flat()
				if (cancelled) return
				setState(events.length >= 2 ? { kind: "ready", events } : { kind: "empty" })
			} catch (error) {
				if (!cancelled) {
					setState({
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					})
				}
			}
		})()
		return () => {
			cancelled = true
		}
	}, [chunks])

	// Mirror the document fullscreen state so the surface can rescale + the
	// button can swap its icon. The <figure> is the fullscreen target.
	React.useEffect(() => {
		const onChange = () => setIsFullscreen(document.fullscreenElement === figureRef.current)
		document.addEventListener("fullscreenchange", onChange)
		return () => document.removeEventListener("fullscreenchange", onChange)
	}, [])

	const toggleFullscreen = React.useCallback(() => {
		if (document.fullscreenElement) void document.exitFullscreen()
		else void figureRef.current?.requestFullscreen()
	}, [])

	return (
		<figure
			ref={figureRef}
			className={cn(
				"m-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm",
				isFullscreen && "flex h-screen w-screen flex-col rounded-none border-0 bg-black",
			)}
		>
			{/* Browser chrome */}
			<div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3.5 py-2.5">
				<div className="flex items-center gap-1.5" aria-hidden>
					<span className="size-3 rounded-full bg-[#ff5f57]" />
					<span className="size-3 rounded-full bg-[#febc2e]" />
					<span className="size-3 rounded-full bg-[#28c840]" />
				</div>
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-background/80 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-inset ring-border">
					<GlobeIcon className="size-3.5 shrink-0 opacity-70" />
					<span className="truncate font-mono">{prettyUrl(url)}</span>
				</div>
			</div>

			{/* Surface + controls */}
			{state.kind === "ready" ? (
				<RrwebSurface
					events={state.events}
					isFullscreen={isFullscreen}
					onToggleFullscreen={toggleFullscreen}
				/>
			) : (
				<div className="relative bg-muted/30">
					{state.kind === "loading" && <PlayerMessage spinner>Loading replay…</PlayerMessage>}
					{state.kind === "error" && (
						<PlayerMessage tone="error">
							Couldn’t load this replay — {state.message}
						</PlayerMessage>
					)}
					{state.kind === "empty" && (
						<PlayerMessage>
							No playable frames yet. The session may still be recording, or its event
							blobs have expired.
						</PlayerMessage>
					)}
				</div>
			)}
		</figure>
	)
}

function PlayerMessage({
	children,
	spinner,
	tone,
}: {
	children: React.ReactNode
	spinner?: boolean
	tone?: "error"
}) {
	return (
		<div className="flex aspect-video w-full items-center justify-center p-8">
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div
					className={
						tone === "error"
							? "grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive"
							: "grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"
					}
				>
					{spinner ? (
						<ArrowPathIcon className="size-5 animate-spin" />
					) : (
						<EyeIcon className="size-5" />
					)}
				</div>
				<p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
			</div>
		</div>
	)
}

const SPEEDS = [0.5, 1, 2, 4, 8] as const

/**
 * A stretch of the recording with no events. rrweb's own `skipInactive`
 * fast-forwards these at `gap / 5s` (so every skip costs ~5s of wall-clock —
 * the slow part), so we skip them ourselves by jumping straight to the end.
 * Offsets are ms from the session start, matching `getCurrentTime()`.
 */
interface InactiveInterval {
	start: number
	end: number
}

/** Gaps longer than this between consecutive events count as idle. */
const IDLE_THRESHOLD_MS = 2000

/** Recorded viewport + click timeline + idle gaps from the raw rrweb stream. */
interface DerivedMeta {
	recordedWidth: number
	recordedHeight: number
	startTime: number
	clickTimestamps: number[]
	inactiveIntervals: InactiveInterval[]
}

function deriveMeta(events: unknown[]): DerivedMeta {
	let recordedWidth = 1280
	let recordedHeight = 720
	const clickTimestamps: number[] = []
	const inactiveIntervals: InactiveInterval[] = []
	const startTime =
		(events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0
	let prevTs = startTime

	for (const raw of events) {
		const ev = raw as {
			type?: number
			timestamp?: number
			data?: { source?: number; type?: number; width?: number; height?: number }
		}
		if (typeof ev.timestamp === "number") {
			if (ev.timestamp - prevTs > IDLE_THRESHOLD_MS) {
				inactiveIntervals.push({ start: prevTs - startTime, end: ev.timestamp - startTime })
			}
			prevTs = ev.timestamp
		}
		if (ev.type === EventType.Meta && ev.data) {
			if (typeof ev.data.width === "number") recordedWidth = ev.data.width
			if (typeof ev.data.height === "number") recordedHeight = ev.data.height
		} else if (
			ev.type === EventType.IncrementalSnapshot &&
			ev.data?.source === IncrementalSource.MouseInteraction &&
			ev.data?.type === MouseInteractions.Click &&
			typeof ev.timestamp === "number"
		) {
			clickTimestamps.push(ev.timestamp)
		}
	}
	return { recordedWidth, recordedHeight, startTime, clickTimestamps, inactiveIntervals }
}

/**
 * Mounts rrweb's `Replayer` into a div and renders our own transport controls.
 * The Replayer rebuilds the recorded page into an <iframe> at its captured
 * viewport size; we scale that wrapper to fit the container with a CSS
 * transform (the trick rrweb-player used internally) and recompute on resize
 * and fullscreen.
 */
function RrwebSurface({
	events,
	isFullscreen,
	onToggleFullscreen,
}: {
	events: unknown[]
	isFullscreen: boolean
	onToggleFullscreen: () => void
}) {
	const mountRef = React.useRef<HTMLDivElement | null>(null)
	const surfaceRef = React.useRef<HTMLDivElement | null>(null)
	const replayerRef = React.useRef<Replayer | null>(null)
	const isFullscreenRef = React.useRef(isFullscreen)
	isFullscreenRef.current = isFullscreen

	const { recordedWidth, recordedHeight, startTime, clickTimestamps, inactiveIntervals } =
		React.useMemo(() => deriveMeta(events), [events])

	const [isPlaying, setIsPlaying] = React.useState(false)
	const [finished, setFinished] = React.useState(false)
	const [currentMs, setCurrentMs] = React.useState(0)
	const [totalMs, setTotalMs] = React.useState(0)
	const [speed, setSpeed] = React.useState(1)
	const [skipInactive, setSkipInactive] = React.useState(true)
	const skipInactiveRef = React.useRef(skipInactive)
	skipInactiveRef.current = skipInactive

	// Fit the recorded viewport into the available width (or both dims when
	// fullscreen), centering the scaled wrapper.
	const applyScale = React.useCallback(() => {
		const replayer = replayerRef.current
		const container = surfaceRef.current
		if (!replayer || !container || !recordedWidth || !recordedHeight) return
		const availW = container.clientWidth
		if (!availW) return
		const fs = isFullscreenRef.current
		let scale: number
		let availH: number
		if (fs) {
			// Let the flex column own the height; drop any windowed inline height.
			container.style.height = ""
			availH = container.clientHeight
			scale = Math.min(availW / recordedWidth, availH / recordedHeight)
		} else {
			scale = availW / recordedWidth
			availH = recordedHeight * scale
			container.style.height = `${Math.round(availH)}px`
		}
		const offsetX = Math.max(0, (availW - recordedWidth * scale) / 2)
		const offsetY = Math.max(0, (availH - recordedHeight * scale) / 2)
		replayer.wrapper.style.transformOrigin = "top left"
		replayer.wrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
	}, [recordedWidth, recordedHeight])

	// Mount the engine. Keyed on `events` — a fresh session rebuilds.
	React.useEffect(() => {
		const mount = mountRef.current
		if (!mount) return
		mount.innerHTML = ""

		// rrweb's `--primary` for the mouse-tail stroke; canvas takes the resolved
		// CSS color. Fall back to a sane accent if the var can't be read.
		const accent =
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() ||
			"#6366f1"

		const replayer = new Replayer(events as never, {
			root: mount,
			speed: 1,
			// We skip idle ourselves by jumping (see the rAF loop) — rrweb's own
			// skipInactive only fast-forwards, which is slow. Keep it off.
			skipInactive: false,
			mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: accent },
			showWarning: false,
			showDebug: false,
			liveMode: false,
		})
		replayerRef.current = replayer
		setTotalMs(replayer.getMetaData().totalTime)

		replayer.on(ReplayerEvents.Start, () => {
			setIsPlaying(true)
			setFinished(false)
		})
		replayer.on(ReplayerEvents.Resume, () => {
			setIsPlaying(true)
			setFinished(false)
		})
		replayer.on(ReplayerEvents.Pause, () => setIsPlaying(false))
		replayer.on(ReplayerEvents.Finish, () => {
			setIsPlaying(false)
			setFinished(true)
		})

		const observer = new ResizeObserver(() => applyScale())
		if (surfaceRef.current) observer.observe(surfaceRef.current)
		applyScale()

		return () => {
			observer.disconnect()
			replayer.destroy()
			replayerRef.current = null
			mount.innerHTML = ""
		}
	}, [events, applyScale])

	// Recompute scale when entering/leaving fullscreen.
	React.useEffect(() => {
		applyScale()
	}, [isFullscreen, applyScale])

	// Poll the engine clock while playing (rrweb has no per-frame time event).
	// While skip-idle is on, jump straight over any inactive gap we land in
	// instead of letting it play out.
	React.useEffect(() => {
		if (!isPlaying) return
		let raf = 0
		const tick = () => {
			const replayer = replayerRef.current
			if (replayer) {
				const cur = replayer.getCurrentTime()
				const gap =
					skipInactiveRef.current &&
					inactiveIntervals.find((iv) => cur >= iv.start && cur < iv.end - 30)
				if (gap) {
					replayer.play(gap.end)
					setCurrentMs(gap.end)
				} else {
					setCurrentMs(Math.min(cur, totalMs))
				}
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [isPlaying, totalMs, inactiveIntervals])

	const togglePlay = React.useCallback(() => {
		const replayer = replayerRef.current
		if (!replayer) return
		if (finished) {
			replayer.play(0)
			setCurrentMs(0)
		} else if (isPlaying) {
			replayer.pause()
		} else {
			const from = currentMs >= totalMs ? 0 : currentMs
			replayer.play(from)
		}
	}, [finished, isPlaying, currentMs, totalMs])

	const seek = React.useCallback(
		(ms: number) => {
			const replayer = replayerRef.current
			if (!replayer) return
			const clamped = Math.max(0, Math.min(ms, totalMs))
			setCurrentMs(clamped)
			if (clamped < totalMs) setFinished(false)
			if (isPlaying && clamped < totalMs) replayer.play(clamped)
			else replayer.pause(clamped)
		},
		[isPlaying, totalMs],
	)

	const changeSpeed = React.useCallback((next: number) => {
		setSpeed(next)
		replayerRef.current?.setConfig({ speed: next })
	}, [])

	const toggleSkipInactive = React.useCallback(() => {
		setSkipInactive((prev) => !prev)
	}, [])

	return (
		<>
			<div
				ref={surfaceRef}
				className={cn(
					"relative w-full overflow-hidden bg-white",
					isFullscreen && "min-h-0 flex-1",
				)}
			>
				<div ref={mountRef} className="absolute inset-0" />
			</div>
			<ReplayControls
				isPlaying={isPlaying}
				finished={finished}
				currentMs={currentMs}
				totalMs={totalMs}
				startTime={startTime}
				clickTimestamps={clickTimestamps}
				speed={speed}
				skipInactive={skipInactive}
				isFullscreen={isFullscreen}
				onTogglePlay={togglePlay}
				onSeek={seek}
				onChangeSpeed={changeSpeed}
				onToggleSkipInactive={toggleSkipInactive}
				onToggleFullscreen={onToggleFullscreen}
			/>
		</>
	)
}

function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function ReplayControls({
	isPlaying,
	finished,
	currentMs,
	totalMs,
	startTime,
	clickTimestamps,
	speed,
	skipInactive,
	isFullscreen,
	onTogglePlay,
	onSeek,
	onChangeSpeed,
	onToggleSkipInactive,
	onToggleFullscreen,
}: {
	isPlaying: boolean
	finished: boolean
	currentMs: number
	totalMs: number
	startTime: number
	clickTimestamps: number[]
	speed: number
	skipInactive: boolean
	isFullscreen: boolean
	onTogglePlay: () => void
	onSeek: (ms: number) => void
	onChangeSpeed: (s: number) => void
	onToggleSkipInactive: () => void
	onToggleFullscreen: () => void
}) {
	return (
		<div className="flex items-center gap-3 border-t border-border bg-card px-3 py-2.5">
			<button
				type="button"
				onClick={onTogglePlay}
				aria-label={finished ? "Replay" : isPlaying ? "Pause" : "Play"}
				className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95"
			>
				{finished ? (
					<ArrowPathIcon className="size-4" />
				) : isPlaying ? (
					<MediaPauseIcon className="size-4" />
				) : (
					<MediaPlayIcon className="size-4 translate-x-px" />
				)}
			</button>

			<Scrubber
				currentMs={currentMs}
				totalMs={totalMs}
				startTime={startTime}
				clickTimestamps={clickTimestamps}
				onSeek={onSeek}
			/>

			<div className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
				<span className="text-foreground">{formatClock(currentMs)}</span>
				<span className="opacity-50">/</span>
				<span>{formatClock(totalMs)}</span>
			</div>

			<div className="flex shrink-0 items-center rounded-md bg-muted p-0.5">
				{SPEEDS.map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => onChangeSpeed(s)}
						className={cn(
							"rounded px-1.5 py-0.5 text-xs font-medium tabular-nums transition-colors",
							speed === s
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{s}×
					</button>
				))}
			</div>

			<button
				type="button"
				onClick={onToggleSkipInactive}
				aria-pressed={skipInactive}
				className={cn(
					"shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors",
					skipInactive
						? "bg-primary/10 text-primary"
						: "text-muted-foreground hover:bg-muted hover:text-foreground",
				)}
			>
				Skip idle
			</button>

			<button
				type="button"
				onClick={onToggleFullscreen}
				aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				{isFullscreen ? (
					<MinimizeIcon className="size-4" />
				) : (
					<MaximizeIcon className="size-4" />
				)}
			</button>
		</div>
	)
}

function Scrubber({
	currentMs,
	totalMs,
	startTime,
	clickTimestamps,
	onSeek,
}: {
	currentMs: number
	totalMs: number
	startTime: number
	clickTimestamps: number[]
	onSeek: (ms: number) => void
}) {
	const trackRef = React.useRef<HTMLDivElement | null>(null)
	const [dragging, setDragging] = React.useState(false)
	const pct = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0

	const msFromClientX = React.useCallback(
		(clientX: number) => {
			const el = trackRef.current
			if (!el) return 0
			const rect = el.getBoundingClientRect()
			const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
			return Math.max(0, Math.min(1, ratio)) * totalMs
		},
		[totalMs],
	)

	const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId)
		setDragging(true)
		onSeek(msFromClientX(e.clientX))
	}
	const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (dragging) onSeek(msFromClientX(e.clientX))
	}
	const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		e.currentTarget.releasePointerCapture(e.pointerId)
		setDragging(false)
	}

	return (
		<div
			ref={trackRef}
			role="slider"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={Math.round(totalMs)}
			aria-valuenow={Math.round(currentMs)}
			tabIndex={0}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			className="group relative h-6 flex-1 cursor-pointer touch-none select-none"
		>
			{/* Track */}
			<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-primary"
					style={{ width: `${pct}%` }}
				/>
			</div>
			{/* Click markers */}
			{totalMs > 0 &&
				clickTimestamps.map((ts, i) => {
					const markerPct = Math.min(100, Math.max(0, ((ts - startTime) / totalMs) * 100))
					return (
						<span
							key={`${ts}-${i}`}
							className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 ring-1 ring-card"
							style={{ left: `${markerPct}%` }}
							title="Click"
						/>
					)
				})}
			{/* Thumb */}
			<div
				className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
				style={{ left: `${pct}%`, opacity: dragging ? 1 : undefined }}
			/>
		</div>
	)
}
