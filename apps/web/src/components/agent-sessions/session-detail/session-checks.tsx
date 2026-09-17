import { useState, type ReactNode } from "react"

import type {
	SessionCheck,
	SessionChecksReport,
	SessionCoverage,
	SessionFinding,
	SessionFixArea,
} from "@maple/agent-sessions"

import { ArrowRightIcon, CheckIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { Pill } from "./pill"

/** The tag on a check that found something: what a fix would touch. */
const FIX_AREA_LABEL = {
	prompt: "Prompt",
	tool: "Tool",
	integration: "Integration",
	model: "Model settings",
	provider: "Provider",
	instrumentation: "Instrumentation",
} satisfies Record<SessionFixArea, string>

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
export function SessionChecks({ report, onOpenSpan }: { report: SessionChecksReport; onOpenSpan: OpenSpan }) {
	const attention = report.checks.filter((check) => check.status === "failed" || check.status === "warning")
	const passed = report.checks.filter((check) => check.status === "passed")
	const skipped = report.checks.filter((check) => check.status === "skipped")

	return (
		<div className="flex flex-col gap-6">
			<Verdict report={report} onOpenSpan={onOpenSpan} />

			<section className="flex flex-col gap-3">
				<SectionHeader
					title="Needs attention"
					aside={`${attention.length} of ${report.checks.length} checks`}
				/>
				{attention.length === 0 ? (
					<p className="flex items-center gap-2 text-sm">
						<CheckIcon size={14} aria-hidden className="shrink-0 text-severity-info" />
						{skipped.length === 0
							? "Nothing to fix. Every check below carries what it measured."
							: `Nothing to fix in what could be checked; ${skipped.length === 1 ? "one check" : `${skipped.length} checks`} had no signal to read.`}
					</p>
				) : (
					<div className="flex flex-col divide-y divide-border">
						{attention.map((check) => (
							<CheckBlock key={check.id} check={check} onOpenSpan={onOpenSpan} />
						))}
					</div>
				)}
			</section>

			<div className="flex flex-col divide-y divide-border border-border border-y">
				<Disclosure
					title="Passed"
					count={passed.length}
					dotClassName="bg-severity-info"
					// A clean session opens its passed list: the facts are the page's
					// content, and a closed row would leave it looking empty.
					defaultOpen={attention.length === 0}
					summary={
						passed.length === 0
							? "Nothing passed"
							: passed.map((check) => check.name).join(" · ")
					}
					openSummary="Each one carries the fact it measured"
				>
					<div className="grid grid-cols-1 gap-x-8 gap-y-1.5 @2xl:grid-cols-2">
						{passed.map((check) => (
							<CheckFact key={check.id} check={check} dotClassName="bg-severity-info" />
						))}
					</div>
				</Disclosure>
				<Disclosure
					title="Not checked"
					count={skipped.length}
					dotClassName="border border-muted-foreground"
					defaultOpen={skipped.length > 0 && attention.length === 0}
					summary={
						skipped.length === 0
							? "Every check had the signal it needed"
							: skipped.map((check) => check.name).join(" · ")
					}
					openSummary="The instrumentation did not carry the signal"
				>
					<div className="flex flex-col gap-1.5">
						{skipped.map((check) => (
							<CheckFact key={check.id} check={check} dotClassName="border border-muted-foreground" />
						))}
					</div>
				</Disclosure>
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
	// The engine's headline is a sentence; the page splits its first word off as
	// the verdict and lets the rest read on in a quieter weight.
	const rest = failed
		? report.headline.charAt(0).toLowerCase() + report.headline.slice(1)
		: report.headline.replace(/^Completed/, "").replace(/^,?\s*/, "")
	const { counts } = report

	return (
		<section className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				<p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-lg">
					<span
						aria-hidden
						className={cn(
							"size-2.5 shrink-0 self-center rounded-full",
							failed ? "bg-destructive" : "bg-severity-info",
						)}
					/>
					<span className={failed ? "text-destructive" : "text-severity-info"}>
						{failed ? "Failed" : "Completed"}
					</span>
					<span aria-hidden className="text-muted-foreground">
						—
					</span>
					<span className="min-w-0 font-normal text-muted-foreground">{rest}</span>
				</p>
				<p className="flex flex-wrap gap-x-2 pl-[1.375rem] font-mono text-xs tabular-nums">
					<Count n={counts.failed} word="failed" tone="text-destructive" />
					<Dot />
					<Count n={counts.warning} word={counts.warning === 1 ? "warning" : "warnings"} tone="text-severity-warn" />
					<Dot />
					<Count n={counts.passed} word="passed" tone="text-severity-info" />
					<Dot />
					<Count n={counts.skipped} word="not checked" tone="text-foreground" />
				</p>
			</div>
			{report.verdict.spanId !== undefined && (
				<Button
					variant="outline"
					size="sm"
					aria-haspopup="dialog"
					onClick={() => onOpenSpan(report.verdict.spanId!)}
				>
					Open failing span
					<ArrowRightIcon size={14} />
				</Button>
			)}
		</section>
	)
}

/** One figure of the count strip: the number carries its tone only when it is
 *  not zero, so a clean strip reads as grey. */
function Count({ n, word, tone }: { n: number; word: string; tone: string }) {
	return (
		<span className="text-muted-foreground">
			<span className={cn("font-semibold", n > 0 ? tone : "text-muted-foreground")}>{n}</span> {word}
		</span>
	)
}

function Dot() {
	return (
		<span aria-hidden className="text-muted-foreground/60">
			·
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* A check that found something                                               */
/* -------------------------------------------------------------------------- */

function CheckBlock({ check, onOpenSpan }: { check: SessionCheck; onOpenSpan: OpenSpan }) {
	const failed = check.status === "failed"
	return (
		<div
			data-testid={`check-${check.id}`}
			className={cn(
				"flex flex-col gap-1.5 border-l-2 py-3 pl-3",
				failed ? "border-l-destructive" : "border-l-severity-warn",
			)}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span
					aria-hidden
					className={cn("size-1.5 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-severity-warn")}
				/>
				<span className="font-semibold text-[15px]">{check.name}</span>
				{check.fixArea !== undefined && <Pill tone="outline">{FIX_AREA_LABEL[check.fixArea]}</Pill>}
			</div>
			<p className="pl-3.5 text-sm leading-relaxed">{withCode(check.headline)}</p>
			{check.action !== undefined && (
				<p className="flex items-start gap-1.5 pl-3.5 font-medium text-[13px] leading-relaxed">
					<ArrowRightIcon size={13} aria-hidden className="mt-1 shrink-0 text-severity-warn" />
					<span>{withCode(check.action)}</span>
				</p>
			)}
			{check.findings.length > 0 && (
				<div className="flex flex-col pl-2">
					{check.findings.map((finding) => (
						<EvidenceRow key={finding.id} finding={finding} failed={failed} onOpenSpan={onOpenSpan} />
					))}
				</div>
			)}
		</div>
	)
}

/** One finding as evidence: the instrumentation's own label, where, and the
 *  line it said — opening the span that is its proof. */
function EvidenceRow({
	finding,
	failed,
	onOpenSpan,
}: {
	finding: SessionFinding
	failed: boolean
	onOpenSpan: OpenSpan
}) {
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			onClick={() => onOpenSpan(finding.spanId)}
			className="group flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left font-mono text-xs hover:bg-accent/40"
		>
			<span className={cn("shrink-0 font-medium", failed ? "text-destructive" : "text-severity-warn")}>
				{finding.label}
				{finding.count > 1 && ` ×${finding.count}`}
			</span>
			<span className="shrink-0 text-muted-foreground">{finding.turnText}</span>
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

/* -------------------------------------------------------------------------- */
/* Passed and not checked                                                     */
/* -------------------------------------------------------------------------- */

function Disclosure({
	title,
	count,
	dotClassName,
	defaultOpen,
	summary,
	openSummary,
	children,
}: {
	title: string
	count: number
	dotClassName: string
	defaultOpen: boolean
	summary: string
	openSummary: string
	children: ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	const disclosable = count > 0
	return (
		<div className="flex flex-col">
			<button
				type="button"
				disabled={!disclosable}
				aria-expanded={disclosable ? open : undefined}
				onClick={() => setOpen((current) => !current)}
				className={cn(
					"flex w-full items-center gap-2 py-2.5 text-left",
					disclosable ? "hover:bg-accent/40" : "cursor-default",
				)}
			>
				<ChevronRightIcon
					size={12}
					aria-hidden
					className={cn("shrink-0 text-muted-foreground transition-transform", open && disclosable && "rotate-90")}
				/>
				<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClassName)} />
				<span className="font-medium text-sm">{title}</span>
				<span className="font-mono text-muted-foreground text-xs tabular-nums">({count})</span>
				<span className="ml-auto min-w-0 truncate pl-4 text-muted-foreground text-xs">
					{open && disclosable ? openSummary : summary}
				</span>
			</button>
			{open && disclosable && <div className="pb-3 pl-6">{children}</div>}
		</div>
	)
}

/** A passed or skipped check as one line: its name, and the fact it measured
 *  or the signal it lacked. */
function CheckFact({ check, dotClassName }: { check: SessionCheck; dotClassName: string }) {
	return (
		<div className="flex items-baseline gap-2 text-sm">
			<span aria-hidden className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", dotClassName)} />
			<span className="shrink-0 font-medium">{check.name}</span>
			<span className="min-w-0 text-muted-foreground text-xs leading-relaxed">{withCode(check.headline)}</span>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

/** What the instrumentation gave the checks: the strip that explains a
 *  skipped row, and says what capturing more would unlock. */
function Coverage({ coverage }: { coverage: SessionCoverage }) {
	const signals = [
		{ label: "messages", on: coverage.messages },
		{ label: "tool args & results", on: coverage.toolPayloads },
		{
			label: coverage.usage === "none" ? "token usage" : `token usage ${coverage.usage}`,
			on: coverage.usage !== "none",
		},
		{ label: "cost", on: coverage.cost },
		{
			label:
				coverage.turns === "conversation"
					? "turns by conversation id"
					: coverage.turns === "agent-root"
						? "turns by agent root"
						: "turns by trace",
			// One turn per trace is the floor, not a turn key; the other two rules
			// found real turn boundaries.
			on: coverage.turns !== "trace",
		},
	]
	return (
		<p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs">
			<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
				Coverage
			</span>
			{signals.map((signal) => (
				<span
					key={signal.label}
					className={cn("flex items-baseline gap-1.5", signal.on ? "text-foreground" : "text-muted-foreground")}
				>
					<span aria-hidden className={signal.on ? "text-severity-info" : ""}>
						{signal.on ? "✓" : "✕"}
					</span>
					{signal.label}
				</span>
			))}
		</p>
	)
}

/** The engine spells identifiers in backticks — tool names, fields — so the
 *  MCP reads them as code; the page sets them in mono the same way. */
function withCode(text: string): ReactNode {
	const parts = text.split(/`([^`]+)`/)
	return parts.map((part, index) =>
		index % 2 === 1 ? (
			// The index is the segment's position in a fixed string.
			// eslint-disable-next-line react/no-array-index-key
			<code key={index} className="font-mono text-[0.92em]">
				{part}
			</code>
		) : (
			part
		),
	)
}

function SectionHeader({ title, aside }: { title: string; aside?: string }) {
	return (
		<div className="flex items-baseline justify-between gap-2">
			<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">{title}</h3>
			{aside !== undefined && (
				<span className="font-mono text-muted-foreground text-xs tabular-nums">{aside}</span>
			)}
		</div>
	)
}
