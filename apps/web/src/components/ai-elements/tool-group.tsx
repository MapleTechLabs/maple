import { useMemo, type ReactNode } from "react"
import type { IconComponent } from "@/components/icons"
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@maple/ui/components/ui/trace"
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
 * the rows into the trace's hairline rail, an aside to the turn's prose rather than a card.
 *
 * The settled header names the work (`Search Traces · Inspect Trace ×4`) because `4 tools`
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
	const running = runningCount > 0
	const count = toolNames.length
	const tools = useMemo(() => tally(toolNames), [toolNames])
	const named = tools.slice(0, NAMED_TOOLS)
	const hidden = tools.length - named.length

	return (
		<Trace data-slot="tool-group">
			<TraceCollapsible>
				<TraceCollapsibleTrigger>
					{/* No `error` status here: one failed call in thirty would paint the whole header
					    red. The `N failed` count says it instead. */}
					<TraceLine status={running ? "running" : undefined}>
						{running ? (
							// No "Running…" prefix and no generic glyph: the loader already says running,
							// and the tool's own activity says more than either.
							<>
								<TraceIcon className="size-5">
									<DotLoader />
								</TraceIcon>
								<TraceTitle className="font-medium">{toolActivity(currentToolName ?? "")}</TraceTitle>
								<TraceDescription>
									{completedCount}/{count}
								</TraceDescription>
								<RunningClock />
							</>
						) : (
							<>
								{/* One glyph per distinct tool: the shape of the burst is readable before
								    the text is, and it survives the truncation the labels don't. */}
								{named.map((tool) => (
									<TraceIcon key={tool.label}>
										<tool.icon className="size-3.5" />
									</TraceIcon>
								))}
								<TraceTitle className="font-medium">
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
								</TraceTitle>
								{errorCount > 0 ? (
									<TraceDescription className="text-severity-error">
										{errorCount} failed
									</TraceDescription>
								) : null}
							</>
						)}
					</TraceLine>
				</TraceCollapsibleTrigger>
				<TraceCollapsibleContent>
					<Trace className="max-h-[55vh] overflow-y-auto">{children}</Trace>
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</Trace>
	)
}
