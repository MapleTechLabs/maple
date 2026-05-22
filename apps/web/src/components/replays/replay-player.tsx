import * as React from "react"
import { GlobeIcon, ArrowPathIcon, EyeIcon } from "@/components/icons"

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
 * fetched from signed R2 URLs, gunzipped, concatenated in order, and handed to
 * rrweb-player.
 */
export function ReplayPlayer({
	chunks,
	url,
}: {
	chunks: ReadonlyArray<ReplayChunkUrl>
	url?: string
}) {
	const [state, setState] = React.useState<PlayerState>({ kind: "loading" })

	const chunkUrls = React.useMemo(() => chunks.map((c) => c.url).join("|"), [chunks])
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chunkUrls])

	return (
		<figure className="m-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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

			{/* Surface */}
			<div className="relative bg-muted/30">
				{state.kind === "loading" && <PlayerMessage spinner>Loading replay…</PlayerMessage>}
				{state.kind === "error" && (
					<PlayerMessage tone="error">Couldn’t load this replay — {state.message}</PlayerMessage>
				)}
				{state.kind === "empty" && (
					<PlayerMessage>
						No playable frames yet. The session may still be recording, or its event blobs
						have expired.
					</PlayerMessage>
				)}
				{state.kind === "ready" && <RrwebSurface events={state.events} />}
			</div>
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

/**
 * Mounts rrweb-player into a div via ref callback (no useEffect — the callback
 * runs on attach and cleanup on detach), the sanctioned way to wrap an
 * imperative third-party widget.
 */
function RrwebSurface({ events }: { events: unknown[] }) {
	const playerRef = React.useRef<{ $destroy?: () => void } | null>(null)
	// Bumped on every attach/detach. Player creation is async (dynamic import),
	// so a stale in-flight creation checks this token before appending —
	// otherwise React StrictMode's attach→detach→attach would mount two players
	// into the same node.
	const tokenRef = React.useRef(0)

	const mount = React.useCallback(
		(node: HTMLDivElement | null) => {
			tokenRef.current += 1
			const token = tokenRef.current

			if (playerRef.current?.$destroy) {
				playerRef.current.$destroy()
				playerRef.current = null
			}
			if (!node) return
			node.innerHTML = ""

			void (async () => {
				const [{ default: RrwebPlayer }] = await Promise.all([
					import("rrweb-player"),
					import("rrweb-player/dist/style.css"),
				])
				// A newer attach/detach happened while importing — abort this one.
				if (token !== tokenRef.current) return
				node.innerHTML = ""
				const width = node.clientWidth || 900
				playerRef.current = new RrwebPlayer({
					target: node,
					props: {
						events: events as never,
						width,
						height: Math.round((width * 9) / 16),
						autoPlay: false,
						showController: true,
					},
				}) as unknown as { $destroy?: () => void }
			})()
		},
		[events],
	)

	return <div ref={mount} className="w-full" />
}
