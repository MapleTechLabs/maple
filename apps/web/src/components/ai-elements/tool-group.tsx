import { useState, type ReactNode } from "react"
import { ChevronDownIcon, CircleCheckIcon, CircleXmarkIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { RunningClock } from "./tool"
import { DotLoader } from "./dot-loader"
import { toolActivity } from "./tool-metadata"

interface ToolGroupProps {
	count: number
	runningCount: number
	errorCount: number
	/** Raw name of the call in flight, so the header says what is actually happening. */
	currentToolName?: string
	/** How many calls in the group have finished, for the `done/total` counter. */
	completedCount: number
	children: ReactNode
}

/**
 * A run of tool calls behind one line.
 *
 * Collapsed by default, even mid-burst: the header carries live progress, so a thirty-call
 * investigation costs the reader a single line instead of a screen of chrome. Expanding drops
 * the rows into a hairline rail rather than a bordered panel — the group is an aside to the
 * turn's prose, and a filled card reads as the main event.
 */
export function ToolGroup({
	count,
	runningCount,
	errorCount,
	currentToolName,
	completedCount,
	children,
}: ToolGroupProps) {
	const [open, setOpen] = useState(false)
	const running = runningCount > 0

	return (
		<div className="text-xs">
			<button
				type="button"
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
				onClick={() => setOpen((v) => !v)}
			>
				{/* The loader only says "in flight"; the header text beside it names the call, so
				    the glyph is decorative and stays out of the accessibility tree. */}
				<span className="flex size-5 shrink-0 items-center justify-center">
					{running ? (
						<DotLoader />
					) : errorCount > 0 ? (
						<CircleXmarkIcon className="size-3.5 text-destructive" />
					) : (
						<CircleCheckIcon className="size-3.5 text-severity-info" />
					)}
				</span>
				{running ? (
					// No "Running…" prefix and no generic code glyph: the loader already says running,
					// and the tool's own name says more than either. Just what's happening, and how
					// far in.
					<span className="min-w-0 flex-1 truncate font-medium text-foreground">
						<span className="shimmer">{toolActivity(currentToolName ?? "")}</span>
						<span className="ml-1.5 font-normal tabular-nums text-muted-foreground/60">
							{completedCount}/{count}
						</span>
					</span>
				) : (
					<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
						{count} tool{count === 1 ? "" : "s"}
						{errorCount > 0 ? (
							<span className="ml-1 font-normal tabular-nums text-destructive">
								· {errorCount} failed
							</span>
						) : null}
					</span>
				)}
				{running ? <RunningClock /> : null}
				<ChevronDownIcon
					className={cn(
						"size-3 shrink-0 text-muted-foreground/60 transition-transform",
						open ? "rotate-0" : "-rotate-90",
					)}
				/>
			</button>
			{open && (
				<div className="ms-[0.9375rem] max-h-[55vh] overflow-y-auto border-s border-border/60 py-0.5 ps-1.5">
					{children}
				</div>
			)}
		</div>
	)
}
