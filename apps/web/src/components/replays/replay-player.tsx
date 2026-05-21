import * as React from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

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

type PlayerState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "empty" } | { kind: "ready"; events: unknown[] }

/**
 * Renders an rrweb session replay. Chunk blobs are fetched from signed R2 URLs,
 * gunzipped in the browser, concatenated in order, and handed to rrweb-player.
 * The player is a Svelte widget instantiated imperatively via a ref callback.
 */
export function ReplayPlayer({ chunks }: { chunks: ReadonlyArray<ReplayChunkUrl> }) {
	const [state, setState] = React.useState<PlayerState>({ kind: "loading" })

	// Load + decode all chunks once per chunk set. Cancels on chunk change.
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
					setState({ kind: "error", message: error instanceof Error ? error.message : String(error) })
				}
			}
		})()
		return () => {
			cancelled = true
		}
		// chunkUrls captures identity of the chunk set
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chunkUrls])

	if (state.kind === "loading") {
		return <Skeleton className="h-full min-h-96 w-full rounded-md" />
	}
	if (state.kind === "error") {
		return (
			<div className="flex h-full min-h-96 items-center justify-center rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
				Failed to load replay: {state.message}
			</div>
		)
	}
	if (state.kind === "empty") {
		return (
			<div className="flex h-full min-h-96 items-center justify-center rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
				This session has no playable events yet. It may still be recording or have expired.
			</div>
		)
	}

	return <RrwebSurface events={state.events} />
}

/**
 * Mounts rrweb-player into a div via ref callback (no useEffect — the callback
 * runs on attach and the cleanup runs on detach), which is the sanctioned way
 * to wrap an imperative third-party widget.
 */
function RrwebSurface({ events }: { events: unknown[] }) {
	const playerRef = React.useRef<{ $destroy?: () => void } | null>(null)

	const mount = React.useCallback(
		(node: HTMLDivElement | null) => {
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

	return <div ref={mount} className="maple-replay-player w-full" />
}
