import { useState } from "react"
import { cn } from "@maple/ui/lib/utils"
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetPanel,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { ChevronRightIcon, CircleCheckIcon, CircleWarningIcon, CircleXmarkIcon } from "@/components/icons"
import { agentPresentation } from "@/components/ai-elements/agent-metadata"
import { DotLoader } from "@/components/ai-elements/dot-loader"
import { RunningClock, Tool } from "@/components/ai-elements/tool"
import { RichText } from "@/components/ai-elements/rich-text"
import type { UIMessage } from "@/components/ai-elements/types"
import { toolNameFor, type ToolPart } from "./transcript-rows"

type TaskStatus = "running" | "completed" | "error" | "aborted"

interface TaskCardProps {
	agent: string
	/** The self-contained question the parent model handed over. */
	prompt: string
	status: TaskStatus
	/** What the sub-agent came back with. Absent while it runs. */
	answer?: string
	errorText?: string
	budgetExhausted?: boolean
	messages: readonly UIMessage[]
}

/** How a settled run reads, in the row's own words. */
const OUTCOME: Record<Exclude<TaskStatus, "running">, string> = {
	completed: "answered",
	error: "failed",
	aborted: "stopped",
}

const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"

function StatusGlyph({ status }: { status: TaskStatus }) {
	return (
		<span className="flex size-5 shrink-0 items-center justify-center">
			{status === "running" ? (
				<DotLoader />
			) : status === "error" ? (
				<CircleXmarkIcon className="size-3.5 text-destructive" />
			) : status === "aborted" ? (
				<CircleWarningIcon className="size-3.5 text-muted-foreground" />
			) : (
				<CircleCheckIcon className="size-3.5 text-severity-info" />
			)}
		</span>
	)
}

/**
 * One sub-agent run, as a line that opens.
 *
 * Deliberately not a tool row and never inside a tool group: a delegation is the one call in a
 * turn that spends a whole agent — its own model, its own tool budget, minutes rather than
 * milliseconds — and folding it in with the warehouse queries said the opposite. Two of them
 * disappeared behind a `2 tools` header, described by whichever argument the generic summariser
 * happened to pick.
 *
 * It is still a *line*, not a panel. A card that spent three lines of the transcript on a question
 * the reader can already see in the prose above buys nothing; what the reader wants is either
 * "a sub-agent is on it" or the whole run. So the row carries the first, and clicking it opens the
 * second in a sheet — the question in full, the answer, and whatever of the child's own transcript
 * reached the parent.
 */
export function TaskCard({
	agent,
	prompt,
	status,
	answer,
	errorText,
	budgetExhausted,
	messages,
}: TaskCardProps) {
	const [open, setOpen] = useState(false)
	const running = status === "running"
	const { label, activity, icon: AgentIcon } = agentPresentation(agent)

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
			>
				<StatusGlyph status={status} />
				{/* While it runs the loader is the glyph; once it settles the agent's own mark is
				    what distinguishes this line from the tool rows around it. */}
				{running ? null : <AgentIcon className="size-3.5 shrink-0 text-muted-foreground/70" />}
				<span
					className={cn(
						"shrink-0 font-medium",
						running ? "shimmer text-foreground" : "text-foreground",
					)}
				>
					{running ? `${activity}…` : label}
				</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
					<span className="mr-1 text-muted-foreground/40">·</span>
					{prompt}
				</span>
				{status === "error" ? (
					<span className="shrink-0 text-[11px] text-destructive">failed</span>
				) : budgetExhausted === true ? (
					<span className="shrink-0 text-[11px] text-warning">partial</span>
				) : null}
				{running ? <RunningClock /> : null}
				<ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
			</button>

			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="sm:max-w-xl">
					<SheetHeader>
						<div className="flex items-center gap-2">
							<AgentIcon className="size-3 shrink-0 text-muted-foreground" />
							<span className={EYEBROW}>{label} sub-agent</span>
							<span className="text-muted-foreground/40">·</span>
							<span className={EYEBROW}>{running ? "running" : OUTCOME[status]}</span>
						</div>
						{/* The question, unclamped — the thing the row cannot show and the reason
						    this panel exists. */}
						<SheetTitle className="text-base leading-snug">{prompt}</SheetTitle>
						<SheetDescription className="sr-only">
							What this sub-agent was asked, and what it came back with.
						</SheetDescription>
					</SheetHeader>
					<SheetPanel className="flex flex-col gap-6">
						{budgetExhausted === true ? (
							<p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
								Answered from what it had: the run spent its budget before it finished
								searching.
							</p>
						) : null}

						<section className="flex flex-col gap-2">
							<h3 className={EYEBROW}>Answer</h3>
							{running ? (
								// A div, not a p: the loader renders a dot grid, which cannot live inside one.
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<DotLoader />
									<span className="shimmer">{activity}…</span>
									<RunningClock />
								</div>
							) : errorText != null ? (
								<pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs text-destructive/80">
									{errorText}
								</pre>
							) : answer != null ? (
								<div className="text-sm">
									<RichText>{answer}</RichText>
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									The run ended without returning an answer.
								</p>
							)}
						</section>

						{/*
						 * Usually empty, and that is the design rather than a gap: the engine keeps a
						 * sub-agent's tool calls in the child's thread and relays only its lifecycle,
						 * which is the whole point of delegating. Conversations that did record them
						 * still replay them here.
						 */}
						{messages.length > 0 ? (
							<section className="flex flex-col gap-2">
								<h3 className={EYEBROW}>Its own steps</h3>
								{messages.map((message) => (
									<div key={message.id} className="flex flex-col gap-1.5">
										{message.parts.map((part, index) =>
											part.type === "text" ? (
												<RichText key={`text-${index}`}>{part.text}</RichText>
											) : part.type === "dynamic-tool" ? (
												<Tool
													key={part.toolCallId}
													toolName={toolNameFor(part as ToolPart)}
													toolCallId={part.toolCallId}
													state={part.state}
													input={part.input}
													output={"output" in part ? part.output : undefined}
													errorText={
														"errorText" in part ? part.errorText : undefined
													}
												/>
											) : null,
										)}
									</div>
								))}
							</section>
						) : null}
					</SheetPanel>
				</SheetContent>
			</Sheet>
		</div>
	)
}
