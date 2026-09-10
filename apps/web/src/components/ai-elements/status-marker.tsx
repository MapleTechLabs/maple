import { Marker, MarkerContent, MarkerIcon } from "@maple/ui/components/ui/marker"
import { cn } from "@maple/ui/lib/utils"
import { RunningClock } from "./tool"
import { DotLoader } from "./dot-loader"

interface StatusMarkerProps {
	children?: string
	className?: string
}

/**
 * The live "the agent is working" row. It is a `Marker`, not a `Message`: it has no
 * turn of its own, so rendering it as an assistant message made screen readers
 * announce a reply that hadn't arrived and left an empty bubble behind once it did.
 *
 * It shows only when nothing else in the turn is live — before the first token, and in
 * the gap between a settled tool burst and the prose that follows. While a tool is
 * running, that tool's own row or group header carries the orb instead, so the state is
 * only ever one loader on screen at a time. See `showsThinkingRow` in `chat-transcript.tsx`.
 *
 * `MarkerIcon` otherwise forces `size-3.5` on its child; the slot is widened to 20px so the
 * 18px dot matrix sits in it without being scaled.
 *
 * Both animations here stay off the React streaming path: `shimmer` is the CSS utility from
 * `@maple/ui/styles/shadcn-utilities.css` (it sweeps `currentColor`, so it inherits the
 * marker's muted tone), and the loader is CSS on static dots. Both respect
 * `prefers-reduced-motion` — the matrix by painting a single resting frame.
 */
export function StatusMarker({ children = "Thinking…", className }: StatusMarkerProps) {
	return (
		<Marker className={cn("text-xs", className)} role="status">
			<MarkerIcon className="size-5">
				<DotLoader />
			</MarkerIcon>
			<MarkerContent className="flex items-center gap-2">
				<span className="shimmer">{children}</span>
				<RunningClock />
			</MarkerContent>
		</Marker>
	)
}
