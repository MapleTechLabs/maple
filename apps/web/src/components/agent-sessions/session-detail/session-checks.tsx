import { useState, type ReactNode } from "react"

import type {
	SessionCheck,
	SessionCheckStatus,
	SessionChecksReport,
	SessionCoverage,
	SessionFinding,
} from "@maple/agent-sessions"

import { ArrowRightIcon, CheckIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

/** One tone per status, for the dot beside a name and the text of a label. */
const STATUS_DOT = {
	failed: "bg-destructive",
	warning: "bg-severity-warn",
	passed: "bg-severity-info",
	skipped: "border border-muted-foreground",
} satisfies Record<SessionCheckStatus, string>

const STATUS_TEXT = {
	failed: "text-destructive",
	warning: "text-severity-warn",
	passed: "text-severity-info",
	skipped: "text-muted-foreground",
} satisfies Record<SessionCheckStatus, string>

/**
 * Every row of the list — a check that found something, a passed fact, a
 * disclosure head — sits on the same three columns: the status mark, the
 * check's name, and what it has to say. One grid is what keeps thirteen
 * rows of very different length reading as one list.
 */
const ROW_GRID = "grid grid-cols-[0.75rem_9.5rem_minmax(0,1fr)] items-baseline gap-x-3"

/** Open a span's payload in the inspection overlay. */
type OpenSpan = (spanId: string) => void

/**
 * The verdict and the checklist under it — the Overview's answer to "did it
 * work, what went wrong, do I have to fix something, what exactly".
 *
 * Only the checks that found something are on the page: each one names what
 * happened with the numbers in the sentence, what to do about it on its own
 * line, and the evidence rows that open the span. Everything that passed is
 * one row away, expanded for a clean session so it still reads as inspected;
 * a check the instrumentation could not support says what to capture.
 */
export function SessionChecks({
	report,
	onOpenSpan,
	onOpenTools,
}: {
	report: SessionChecksReport
	onOpenSpan: OpenSpan
	/** Bring the Overview's tool ledger into view: the tool-errors check's next step. */
	onOpenTools: () => void
}) {
	const attention = report.checks.filter((check) => check.status === "failed" || check.status === "warning")
	const passed = report.checks.filter((check) => check.status === "passed")
	const skipped = report.checks.filter((check) => check.status === "skipped")
	const clean = attention.length === 0

	return (
		<div className="flex flex-col gap-5">
			<Verdict report={report} onOpenSpan={onOpenSpan} />

			<section className="flex flex-col gap-2">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Needs attention
				</h3>
				{clean ? (
					<p className="flex items-center gap-2 py-2 text-[13px]">
						<CheckIcon size={14} aria-hidden className="shrink-0 text-severity-info" />
						{skipped.length === 0
							? "Nothing to fix. Every check below carries what it measured."
							: `Nothing to fix in what could be checked; ${skipped.length === 1 ? "one check" : `${skipped.length} checks`} had no signal to read.`}
					</p>
				) : (
					<div className="flex flex-col divide-y divide-border border-border border-y">
						{attention.map((check) => (
							<CheckBlock
								key={check.id}
								check={check}
								onOpenSpan={onOpenSpan}
								onOpenTools={onOpenTools}
							/>
						))}
					</div>
				)}
			</section>

			<div className="flex flex-col divide-y divide-border border-border border-y">
				{/* A clean session opens its passed list: the facts are the page's
				    content, and a closed row would leave it looking empty. */}
				<Disclosure
					title="Passed"
					status="passed"
					checks={passed}
					open={clean}
					emptySummary="Nothing passed"
					className="flex flex-col gap-1.5"
				/>
				{/* A session every check could read has no row here: the count
				    strip already says "0 not checked", and a row announcing that
				    nothing is missing is one more line to read past. */}
				{skipped.length > 0 && (
					<Disclosure
						title="Not checked"
						status="skipped"
						checks={skipped}
						open={clean}
						emptySummary="Every check had the signal it needed"
						className="flex flex-col gap-1.5"
					/>
				)}
			</div>

			<Coverage coverage={report.coverage} />
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

function Verdict({ report, onOpenSpan }: { report: SessionChecksReport; onOpenSpan: OpenSpan }) {
	const failed = report.verdict.status === "failed"
	const { counts } = report
	// Only a failed verdict carries the span it failed on.
	const failingSpanId = report.verdict.spanId
	// Red for anything that ended the run or needs a fix, amber for something
	// worth a look, green only when nothing was found.
	const tone: SessionCheckStatus =
		failed || counts.failed > 0 ? "failed" : counts.warning > 0 ? "warning" : "passed"

	return (
		<section className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div className="flex min-w-0 flex-col gap-1">
				<p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-base">
					<span
						aria-hidden
						className={cn("size-2 shrink-0 self-center rounded-full", STATUS_DOT[tone])}
					/>
					{/* The word alone: the report's headline and its counts restate
					    the list right under it — the checks that need attention, and
					    how many passed. They are the MCP's line. */}
					<span className={STATUS_TEXT[tone]}>{failed ? "Failed" : "Completed"}</span>
				</p>
			</div>
			{failingSpanId !== undefined && (
				<Button
					variant="outline"
					size="sm"
					aria-haspopup="dialog"
					onClick={() => onOpenSpan(failingSpanId)}
				>
					Open failing span
					<ArrowRightIcon size={14} />
				</Button>
			)}
		</section>
	)
}

/* -------------------------------------------------------------------------- */
/* A check that found something                                               */
/* -------------------------------------------------------------------------- */

/** The page has a section the MCP does not: the tool ledger at the bottom,
 *  with every call's arguments and result. For tool failures that is the
 *  next step, so the page's action points there instead of the engine's. */
function CheckBlock({
	check,
	onOpenSpan,
	onOpenTools,
}: {
	check: SessionCheck
	onOpenSpan: OpenSpan
	onOpenTools: () => void
}) {
	// The page has a section the MCP does not — the tool ledger at the bottom,
	// with every call's arguments and result — so for tool failures the page's
	// next step is a jump there rather than the engine's line.
	const toolsAction = check.id === "tool-errors"
	return (
		<div data-testid={`check-${check.id}`} className={cn(ROW_GRID, "py-3")}>
			<StatusDot status={check.status} />
			<span className="truncate font-semibold text-[13px]">{check.name}</span>
			<div className="flex min-w-0 flex-col gap-1">
				<p className="text-[13px] leading-relaxed">{withCode(check.headline)}</p>
				{toolsAction ? (
					<p className="flex items-start gap-1.5 text-muted-foreground text-xs leading-relaxed">
						<ArrowRightIcon size={12} aria-hidden className="mt-[3px] shrink-0" />
						<span>
							Check the{" "}
							<button
								type="button"
								onClick={onOpenTools}
								className="underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-muted-foreground"
							>
								Tools section
							</button>{" "}
							at the bottom of this page for details.
						</span>
					</p>
				) : (
					check.action !== undefined && (
						<p className="flex items-start gap-1.5 text-muted-foreground text-xs leading-relaxed">
							<ArrowRightIcon size={12} aria-hidden className="mt-[3px] shrink-0" />
							<span>{withCode(check.action)}</span>
						</p>
					)
				)}
				{check.findings.length > 0 && (
					<div className="-ml-1.5 mt-0.5 flex flex-col">
						{check.findings.map((finding) => (
							<EvidenceRow
								key={finding.id}
								finding={finding}
								status={check.status}
								onOpenSpan={onOpenSpan}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	)
}

/** One finding as evidence: the instrumentation's own label, where, and the
 *  line it said — opening the span that is its proof. */
function EvidenceRow({
	finding,
	status,
	onOpenSpan,
}: {
	finding: SessionFinding
	status: SessionCheckStatus
	onOpenSpan: OpenSpan
}) {
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			onClick={() => onOpenSpan(finding.spanId)}
			className="group flex w-full items-baseline gap-2 rounded-sm px-1.5 py-0.5 text-left font-mono text-xs hover:bg-accent/40"
		>
			<span className={cn("shrink-0", STATUS_TEXT[status])}>
				{finding.label}
				{finding.count > 1 && ` ×${finding.count}`}
			</span>
			<span className="shrink-0 text-muted-foreground/70">{finding.turnText}</span>
			{finding.detail !== undefined && (
				<span className="min-w-0 truncate text-muted-foreground">{finding.detail}</span>
			)}
			<span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
				inspect
				<ArrowRightIcon size={12} />
			</span>
		</button>
	)
}

function StatusDot({ status }: { status: SessionCheckStatus }) {
	return (
		<span
			aria-hidden
			className={cn("size-1.5 shrink-0 translate-y-[-1px] justify-self-center rounded-full", STATUS_DOT[status])}
		/>
	)
}

/* -------------------------------------------------------------------------- */
/* Passed and not checked                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A collapsed row of checks with the same status. `open` is the page's
 * default for the session in front of it — it follows the report as spans
 * arrive — until the reader toggles the row, after which their choice stands
 * for as long as the Overview is mounted.
 */
function Disclosure({
	title,
	status,
	checks,
	open,
	emptySummary,
	className,
}: {
	title: string
	status: SessionCheckStatus
	checks: readonly SessionCheck[]
	open: boolean
	/** What the row says when it has nothing in it. */
	emptySummary: string
	className: string
}) {
	const [choice, setChoice] = useState<boolean | undefined>(undefined)
	const disclosable = checks.length > 0
	const expanded = disclosable && (choice ?? open)
	const head = (
		<>
			<ChevronRightIcon
				size={12}
				aria-hidden
				className={cn(
					"shrink-0 translate-y-px justify-self-center text-muted-foreground transition-transform",
					expanded && "rotate-90",
					!disclosable && "invisible",
				)}
			/>
			<span className="flex items-baseline gap-2">
				<span className={cn("font-semibold text-[13px]", disclosable ? STATUS_TEXT[status] : "text-muted-foreground")}>
					{title}
				</span>
				<span className="font-mono text-muted-foreground text-xs tabular-nums">{checks.length}</span>
			</span>
			{/* Collapsed, the row lists what is inside it; open, the list is
			    right below and the head says nothing twice. */}
			<span className="min-w-0 truncate text-muted-foreground text-xs">
				{!disclosable ? emptySummary : expanded ? "" : checks.map((check) => check.name).join(" · ")}
			</span>
		</>
	)
	// An empty row has nothing to disclose, so it is a line of text rather
	// than a control a screen reader would announce as unavailable.
	if (!disclosable) return <div className={cn(ROW_GRID, "py-2.5")}>{head}</div>
	return (
		<div className="flex flex-col">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setChoice(!expanded)}
				className={cn(ROW_GRID, "w-full py-2.5 text-left hover:bg-accent/40")}
			>
				{head}
			</button>
			{expanded && (
				<div className={cn("pt-0.5 pb-3", className)}>
					{checks.map((check) => (
						<CheckFact key={check.id} check={check} />
					))}
				</div>
			)}
		</div>
	)
}

/** A passed or skipped check as one line: its name, and the fact it measured
 *  or the signal it lacked. */
function CheckFact({ check }: { check: SessionCheck }) {
	return (
		<div className={ROW_GRID}>
			<StatusDot status={check.status} />
			<span className="truncate text-[13px]">{check.name}</span>
			<span className="min-w-0 text-muted-foreground text-xs leading-relaxed">
				{withCode(check.headline)}
			</span>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

/** One captured signal: what it is, and what the checks do with it — or
 *  what is missing without it. */
interface Signal {
	readonly label: string
	readonly on: boolean
	readonly title: string
	readonly explains: string
}

function coverageSignals(coverage: SessionCoverage): readonly Signal[] {
	const usage = coverage.usage
	const turns = coverage.turns
	return [
		{
			label: "messages",
			on: coverage.messages,
			title: "Messages",
			explains: coverage.messages
				? "The prompts and replies of each model call, as the instrumentation recorded them. The Transcript shows them, and Refusals and Reply length read the actual text."
				: "No model call recorded its prompts or replies. Message capture is opt-in in most SDKs; without it the Transcript is structure only, and Refusals and Reply length go by status codes alone.",
		},
		{
			label: "tool args & results",
			on: coverage.toolPayloads,
			title: "Tool arguments and results",
			explains: coverage.toolPayloads
				? "What each tool was called with and what it returned. The tool ledger shows them, and Tool errors and Tool arguments read the error text."
				: "No tool call recorded its arguments or result. Without them a failed call has only its status, and Repeated calls cannot tell identical calls apart.",
		},
		{
			label: usage === "none" ? "token usage" : `token usage ${usage}`,
			on: usage !== "none",
			title: "Token usage",
			explains:
				usage === "per-call" || usage === "roll-up"
					? "Input, output and cache tokens reported on every model call. Context window and Prompt cache read them call by call."
					: usage === "session-level"
						? "Token counts were reported once for the whole session rather than per call, so Context window and Prompt cache cannot follow the prompt from call to call."
						: "No span reported token usage. Context window and Prompt cache have nothing to read.",
		},
		{
			label: "cost",
			on: coverage.cost,
			title: "Cost",
			explains: coverage.cost
				? "The price the instrumentation stamped on each call. Maple prices nothing itself — this is what the emitter reported, not a bill."
				: "No span carried a cost. Maple prices nothing itself, so the session has no cost figure.",
		},
		{
			label:
				turns === "conversation"
					? "turns by conversation id"
					: turns === "agent-root"
						? "turns by agent root"
						: "turns by trace",
			// One turn per trace is the floor, not a turn key; the other two rules
			// found real turn boundaries.
			on: turns === "conversation" || turns === "agent-root",
			title: "Turns",
			explains:
				turns === "conversation"
					? "Turns are cut at the conversation id the instrumentation stamped on its spans — the real boundaries between one exchange and the next."
					: turns === "agent-root"
						? "Turns are cut at each agent's root span, the closest thing to an exchange the spans carry. Stalls and Repeated calls look within a turn."
						: "The spans carried no conversation id and no agent root, so each trace counts as one turn. Stalls and Repeated calls, which look within a turn, are reading a guess.",
		},
	]
}

/** What the instrumentation gave the checks: the line that explains a
 *  skipped row, and says what capturing more would unlock. Each signal
 *  carries its own explanation in a tooltip. */
function Coverage({ coverage }: { coverage: SessionCoverage }) {
	return (
		<p className={cn(ROW_GRID, "text-xs")}>
			<span />
			<span className="text-muted-foreground">Captured</span>
			<span className="flex flex-wrap gap-x-4 gap-y-1">
				{coverageSignals(coverage).map((signal) => (
					<Tooltip key={signal.label}>
						<TooltipTrigger
							render={<span />}
							className={cn(
								"flex cursor-help items-baseline gap-1.5 underline decoration-dotted decoration-muted-foreground/40 underline-offset-[3px]",
								signal.on ? "text-muted-foreground" : "text-muted-foreground/60 line-through",
							)}
						>
							<span aria-hidden className={signal.on ? "text-severity-info" : "text-destructive"}>
								{signal.on ? "✓" : "✕"}
							</span>
							<span className="sr-only">{signal.on ? "captured:" : "not captured:"}</span>
							{signal.label}
						</TooltipTrigger>
						<TooltipContent className="max-w-72">
							<span className="flex flex-col gap-1 py-1 text-left leading-relaxed">
								<span className="font-semibold">{signal.title}</span>
								<span className="text-muted-foreground">{signal.explains}</span>
							</span>
						</TooltipContent>
					</Tooltip>
				))}
			</span>
		</p>
	)
}

/**
 * The engine spells identifiers in backticks — tool names, fields — so the
 * MCP reads them as code; the page sets them in mono the same way. A line
 * with an odd number of backticks carries one from a raw error message, and
 * is left alone rather than flipping every segment after it.
 */
function withCode(text: string): ReactNode {
	const parts = text.split(/`([^`]+)`/)
	if (parts.length === 1 || (text.match(/`/g)?.length ?? 0) % 2 === 1) return text
	return parts.map((part, index) =>
		index % 2 === 1 ? (
			// The index is the segment's position in one fixed string.
			<code key={index} className="font-mono text-[0.92em]">
				{part}
			</code>
		) : (
			part
		),
	)
}
