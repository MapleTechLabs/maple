import * as React from "react"
import "@rrweb/replay/dist/style.css"
import { cn } from "@maple/ui/utils"
import { errorMessage, useReplayPlayer } from "./replay-player-context"
import {
	GlobeIcon,
	ArrowPathIcon,
	EyeIcon,
	MaximizeIcon,
	MinimizeIcon,
} from "@/components/icons"

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
 * The replay video surface: an rrweb-rebuilt page inside faux-browser chrome
 * (traffic lights + address bar + fullscreen). The engine and all transport
 * state live in `ReplayPlayerProvider`; this component only renders the mount
 * point (the engine attaches to `mountRef`) and the per-status messaging. The
 * transport controls + scrubber live in `<ReplayEditorTimeline>` below.
 */
export function ReplaySurface({ url }: { url?: string }) {
	const { status, error, figureRef, surfaceRef, mountRef, isFullscreen, toggleFullscreen } =
		useReplayPlayer()

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
				<button
					type="button"
					onClick={toggleFullscreen}
					aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
					className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					{isFullscreen ? (
						<MinimizeIcon className="size-4" />
					) : (
						<MaximizeIcon className="size-4" />
					)}
				</button>
			</div>

			{/* Surface — the engine mounts into the inner div. Messages overlay when
			    there's nothing playable. The mount stays in the tree across statuses
			    so its ref is attached when the provider's engine effect runs. */}
			<div
				ref={surfaceRef}
				className={cn(
					"relative w-full overflow-hidden bg-white",
					isFullscreen && "min-h-0 flex-1",
				)}
			>
				<div ref={mountRef} className="absolute inset-0" />
				{status !== "ready" && (
					<div className="absolute inset-0 bg-muted/30">
						{status === "loading" && <PlayerMessage spinner>Loading replay…</PlayerMessage>}
						{status === "error" && (
							<PlayerMessage tone="error">
								Couldn’t load this replay — {errorMessage(error)}
							</PlayerMessage>
						)}
						{status === "empty" && (
							<PlayerMessage>
								No playable frames yet. The session may still be recording, or its event blobs
								have expired.
							</PlayerMessage>
						)}
					</div>
				)}
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
