import { useMemo, useState, type ReactNode } from "react"
import { ChevronDownIcon, CircleCheckIcon, CircleXmarkIcon } from "@/components/icons"
import type { IconComponent } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { RunningClock } from "./tool"
import { DotLoader } from "./dot-loader"
import { toolActivity, toolIcon, toolLabel } from "./tool-metadata"

interface ToolGroupProps {
	/** Raw names of every call in the group, in call order — the header says what they were. */
	toolNames: readonly string[]
	runningCount: number
	errorCount: number
	/** Raw name of the call in flight, so the header says what is actually happening. */
	currentToolName?: string
	/** How many calls in the group have finished, for the `done/total` counter. */
	completedCount: number
	children: ReactNode
}

interface ToolTally {
	label: string
	icon: IconComponent
	count: number
}

/** Distinct tools in call order, each with how many times it was called. */
function tally(toolNames: readonly string[]): ToolTally[] {
	const byLabel = new Map<string, ToolTally>()
	for (const name of toolNames) {
		const label = toolLabel(name)
		const seen = byLabel.get(label)
		if (seen) seen.count += 1
		else byLabel.set(label, { label, icon: toolIcon(name), count: 1 })
	}
	return [...byLabel.values()]
}

/** How many distinct tools the header names before falling back to `+N more`. */
const NAMED_TOOLS = 3

/**
 * A run of tool calls behind one line.
 *
 * Collapsed by default, even mid-burst: the header carries live progress, so a thirty-call
 * investigation costs the reader a single line instead of a screen of chrome. Expanding drops
 * the rows into a hairline rail rather than a bordered panel — the group is an aside to the
 * turn's prose, and a filled card reads as the main event.
 *
 * The settled header names the work — `Search Traces · Inspect Trace ×4` — because `4 tools`
 * told the reader only that something happened. Naming it is what makes the collapsed line
 * worth leaving collapsed.
 */
export function ToolGroup({
	toolNames,
	runningCount,
	errorCount,
	currentToolName,
	completedCount,
	children,
}: ToolGroupProps) {
	const [open, setOpen] = useState(false)
	const running = runningCount > 0
	const count = toolNames.length
	const tools = useMemo(() => tally(toolNames), [toolNames])
	const named = tools.slice(0, NAMED_TOOLS)
	const hidden = tools.length - named.length

	return (
		<div className="text-xs" data-slot="tool-group">
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
					<>
						{/* One glyph per distinct tool: the shape of the burst is readable before
						    the text is, and it survives the truncation the labels don't. */}
						<span className="flex shrink-0 items-center gap-1">
							{named.map((tool) => (
								<tool.icon
									key={tool.label}
									className="size-3.5 shrink-0 text-muted-foreground/70"
								/>
							))}
						</span>
						<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
							{named.map((tool, i) => (
								<span key={tool.label}>
									{i > 0 ? <span className="text-muted-foreground/40"> · </span> : null}
									{tool.label}
									{tool.count > 1 ? (
										<span className="font-normal tabular-nums text-muted-foreground/60">
											{" "}
											×{tool.count}
										</span>
									) : null}
								</span>
							))}
							{hidden > 0 ? (
								<span className="font-normal text-muted-foreground/60"> +{hidden} more</span>
							) : null}
						</span>
						{errorCount > 0 ? (
							<span className="shrink-0 font-normal tabular-nums text-destructive">
								{errorCount} failed
							</span>
						) : null}
					</>
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
