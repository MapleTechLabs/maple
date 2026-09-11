import { useMemo, useState, type ReactNode } from "react"

import type { GetAiSessionSummaryResponse } from "@maple/domain/http"

import { ArrowRightIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { Separator } from "@maple/ui/components/ui/separator"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import {
	buildSessionFindings,
	type FindingSeverity,
	type SessionFinding,
	type SessionVerdict,
} from "@/lib/agent-sessions/session-findings"
import {
	formatCost,
	type SessionSummary,
	type SessionToolCall,
	type SessionToolUsage,
} from "@/lib/agent-sessions/session-summary"
import { buildSessionAxis, type SessionAxis } from "@/lib/agent-sessions/session-axis"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { TOKEN_BUCKETS } from "@/lib/agent-sessions/token-buckets"
import type { SessionToolResults } from "@/lib/agent-sessions/span-detail"
import { useDetectedModels } from "@/hooks/use-detected-models"
import type { SessionLoadProgress } from "@/hooks/use-session-spans"
import { SessionLoadIndicator } from "./session-load-indicator"
import { ModelLabel } from "../model-label"
import type { SpanDetailTab } from "./span-expansion"
import { SpanPopover } from "./span-popover"
import {
	AGENT_TIME_FILL,
	AGENT_TIME_ICON,
	AGENT_TIME_LABEL,
	AGENT_TIME_TEXT,
	type TimeBandKind,
} from "./span-visuals"

const SEVERITY_DOT = {
	failure: "bg-destructive",
	anomaly: "bg-severity-warn",
} satisfies Record<FindingSeverity, string>

/**
 * The triage view: did the session work, and if not, what exactly went wrong.
 *
 * The page leads with a verdict and a findings list rather than another way to
 * browse the turns — Traces, Flow and Transcript already do that three ways.
 * Every finding opens the span that is its evidence in the inspection overlay,
 * over this page rather than instead of it: reading a finding used to cost the
 * reader the page. The facts — time bar, cost, tokens, tools — stay, each
 * figure appearing exactly once.
 */
export function SessionOverview({
	turns,
	summary,
	progress,
	totals,
	selectedSpanId,
	onSelectSpan,
	spanTab,
	onSpanTabChange,
	toolResults,
	onOpenTraceView,
}: {
	turns: readonly SessionTurn[]
	summary: SessionSummary
	/**
	 * The background load of a session larger than one page. Everything on
	 * this page is a statement about the whole session — a verdict, findings,
	 * the tool ledger — so it waits for the agent's spans to all be in hand
	 * rather than pronounce on half of them; the app's spans, which none of it
	 * reads, may still be arriving behind it.
	 */
	progress?: SessionLoadProgress
	/** The whole session's totals, for the wait's progress count. */
	totals?: GetAiSessionSummaryResponse
	/** The one span open in the popover (`?span=`). */
	selectedSpanId: string | undefined
	/** Raised with a span id to open it, `undefined` to close. */
	onSelectSpan: (spanId: string | undefined) => void
	/** The popover's tab, shared with the other views. */
	spanTab: SpanDetailTab | undefined
	onSpanTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id, for the popover. */
	toolResults?: SessionToolResults
	/** The popover's "Open in Traces view": same span, sibling view. */
	onOpenTraceView: () => void
}) {
	const report = useMemo(() => buildSessionFindings(turns, summary), [turns, summary])
	const spansById = useMemo(
		() => new Map(turns.flatMap((turn) => turn.spans).map((span) => [span.spanId, span])),
		[turns],
	)

	const openSpan = (spanId: string) => onSelectSpan(selectedSpanId === spanId ? undefined : spanId)

	if (progress !== undefined && !progress.agentSpansComplete) {
		return (
			<div
				data-testid="overview-waiting"
				className="flex grow flex-col items-center justify-center gap-3 py-16 text-center"
			>
				<p className="text-sm text-muted-foreground">
					The overview reads the whole session, and this one is still arriving.
				</p>
				<SessionLoadIndicator progress={progress} totals={totals} className="items-center" />
				<p className="text-xs text-muted-foreground/70">
					The Traces, Flow and Transcript views already show what has loaded.
				</p>
			</div>
		)
	}

	return (
		<div className="@container flex grow flex-col pt-5 pb-10">
			<div className="flex flex-col gap-8 @4xl:flex-row @4xl:gap-8">
				{/* One rhythm down the column: every section answers a different
				    question, so every boundary is the same hairline with the same
				    air either side of it. */}
				<div className="flex min-w-0 grow flex-col gap-6">
					{/* A session that completed with findings has no verdict line: the
					    findings below are the verdict, and a headline counting them
					    only said it twice. Failed and clean sessions do carry one —
					    there the line is the only place the outcome is stated. */}
					{report.verdict.status !== "attention" && (
						<>
							<Verdict verdict={report.verdict} turns={turns} onOpenSpan={openSpan} />
							<Separator />
						</>
					)}
					<TimeComposition summary={summary} />
					<Separator />
					<Findings findings={report.findings} onOpenSpan={openSpan} />
					<Separator />
					<ToolUsage summary={summary} onOpenSpan={openSpan} />
				</div>
				<Rail summary={summary} />
			</div>

			<SpanPopover
				span={selectedSpanId === undefined ? undefined : spansById.get(selectedSpanId)}
				tab={spanTab}
				onTabChange={onSpanTabChange}
				toolResults={toolResults}
				onClose={() => onSelectSpan(undefined)}
				onOpenTraceView={onOpenTraceView}
			/>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

/** Open a span's payload in the inspection overlay; opening the one already
 *  open closes it. */
type OpenSpan = (spanId: string) => void

function Verdict({
	verdict,
	turns,
	onOpenSpan,
}: {
	verdict: SessionVerdict
	turns: readonly SessionTurn[]
	onOpenSpan: OpenSpan
}) {
	const turnWord = turns[0]?.anchorKind === "trace" ? "segment" : "turn"
	const turnsText = `${turns.length} ${turnWord}${turns.length === 1 ? "" : "s"}`

	return (
		<section className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				{verdict.status === "failed" ? (
					<>
						<p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-lg">
							<VerdictDot className="bg-destructive" />
							<span className="text-destructive">Failed</span>
							{verdict.label !== undefined && (
								<>
									<span aria-hidden className="text-muted-foreground">
										—
									</span>
									<span className="min-w-0 truncate font-mono text-[0.95em]">
										{verdict.label}
									</span>
									<span>on the final {turnWord}</span>
								</>
							)}
						</p>
						<p className="pl-[1.375rem] text-muted-foreground text-sm">
							The final {turnWord} did not close cleanly.
						</p>
					</>
				) : (
					<>
						<p className="flex items-baseline gap-x-2 font-semibold text-lg">
							<VerdictDot className="bg-severity-info" />
							<span className="text-severity-info">Completed cleanly</span>
						</p>
						<p className="pl-[1.375rem] text-muted-foreground text-sm">
							No errors, refusals, truncated replies, stalls, or repetition across {turnsText}.
						</p>
					</>
				)}
			</div>
			{verdict.spanId !== undefined && (
				<Button
					variant="outline"
					size="sm"
					aria-haspopup="dialog"
					onClick={() => onOpenSpan(verdict.spanId!)}
				>
					Open failing span
					<ArrowRightIcon size={14} />
				</Button>
			)}
		</section>
	)
}

function VerdictDot({ className }: { className: string }) {
	return <span aria-hidden className={cn("size-2.5 shrink-0 self-center rounded-full", className)} />
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function Findings({ findings, onOpenSpan }: { findings: readonly SessionFinding[]; onOpenSpan: OpenSpan }) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Findings
				</h3>
				{findings.length > 0 && (
					<span
						className={cn(
							"font-mono text-xs tabular-nums",
							findings.some((finding) => finding.severity === "failure")
								? "text-destructive"
								: "text-severity-warn",
						)}
					>
						{findings.length}
					</span>
				)}
			</div>

			{findings.length === 0 ? (
				<p className="border-border border-t py-5 text-muted-foreground text-sm">No findings.</p>
			) : (
				findings.map((finding) => (
					<FindingRow key={finding.id} finding={finding} onOpenSpan={onOpenSpan} />
				))
			)}
		</section>
	)
}

function FindingRow({ finding, onOpenSpan }: { finding: SessionFinding; onOpenSpan: OpenSpan }) {
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			onClick={() => onOpenSpan(finding.spanId)}
			className={cn(
				"group flex w-full items-start gap-3 border-border border-t px-3 py-2.5 text-left hover:bg-accent/40",
				finding.severity === "failure" &&
					"border-l-2 border-l-destructive bg-destructive/[0.06] pl-2.5",
			)}
		>
			<span
				aria-hidden
				className={cn("mt-[0.4rem] size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])}
			/>
			<span className="flex min-w-0 grow flex-col gap-0.5">
				<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span
						className={cn(
							"min-w-0 truncate font-medium font-mono text-[13px]",
							finding.severity === "failure" && "text-destructive",
						)}
					>
						{finding.label}
						{finding.count > 1 && ` ×${finding.count}`}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">{finding.turnText}</span>
				</span>
				{finding.detail !== undefined && (
					<span className="text-muted-foreground text-xs leading-relaxed">{finding.detail}</span>
				)}
			</span>
			<span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
				inspect
				<ArrowRightIcon size={12} />
			</span>
		</button>
	)
}

/* -------------------------------------------------------------------------- */
/* Where the time went                                                        */
/* -------------------------------------------------------------------------- */

function TimeComposition({ summary }: { summary: SessionSummary }) {
	const { segments, totalMs, peakParallel } = summary.agentTime
	// Agent time, not the clock: each band is the whole time that class of work
	// ran, summed across every agent, so two subagents inferring at once are two
	// seconds here per second of wall clock — the fan-out made visible rather
	// than a double count. Idle joins them because nothing at all was running
	// then, which makes it disjoint from every band and honest to add. Where any
	// of it fell chronologically is the waterfall's question.
	const bands: readonly { kind: TimeBandKind; ms: number }[] = [
		...segments,
		...(summary.idleMs > 0 ? [{ kind: "idle" as const, ms: summary.idleMs }] : []),
	]
	const total = Math.max(
		bands.reduce((sum, band) => sum + band.ms, 0),
		1,
	)
	const legend = bands
		.map((band) => ({ ...band, percent: sharePercent(band.ms, total) }))
		// Under half a percent a legend row reads "0%" and says nothing; the band
		// is still drawn, so nothing vanishes from the bar.
		.filter((band) => band.percent >= 0.5)

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Where the time went
				</h3>
				{/* The two clocks the bands are read against, stated rather than left
				    to be inferred from the bar — and the fan-out that makes them
				    differ, which is the one number the bar itself cannot show. */}
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<Clock
						label="Agent time"
						value={formatSessionDuration(totalMs)}
						className="text-chart-ai-inference"
					/>
					<Clock label="Wall clock" value={formatSessionDuration(summary.wallClockMs)} />
					{peakParallel > 1 && (
						<span
							className="flex items-baseline gap-1.5 rounded-sm bg-chart-ai-agent/12 px-1.5 py-0.5 text-chart-ai-agent"
							title={`At its widest, ${peakParallel} model calls or tools were running at the same time.`}
						>
							<span className="font-mono font-semibold text-xs tabular-nums">
								{peakParallel}×
							</span>
							<span className="text-[11px]">agents in parallel</span>
						</span>
					)}
				</div>
			</div>

			<div className="flex h-4 w-full overflow-hidden rounded-sm bg-muted">
				{bands.map((band) => (
					<div
						key={band.kind}
						className={AGENT_TIME_FILL[band.kind]}
						style={{ width: `${(band.ms / total) * 100}%` }}
					/>
				))}
			</div>

			<div className="flex flex-wrap gap-x-6 gap-y-2">
				{legend.map((band) => {
					const Icon = AGENT_TIME_ICON[band.kind]
					return (
						<span key={band.kind} className="flex items-center gap-2 text-[13px]">
							<Icon
								size={14}
								aria-hidden
								className={cn("shrink-0", AGENT_TIME_TEXT[band.kind])}
							/>
							<span>{AGENT_TIME_LABEL[band.kind]}</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{formatSessionDuration(band.ms)} · {formatPercent(band.percent / 100)}
							</span>
						</span>
					)
				})}
			</div>
		</section>
	)
}

/** One of the section's two clocks: a micro label with the number carrying the
 *  weight, so the pair reads as facts rather than a line of grey prose. */
function Clock({ label, value, className }: { label: string; value: string; className?: string }) {
	return (
		<span className="flex items-baseline gap-1.5">
			<span className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
				{label}
			</span>
			<span className={cn("font-mono font-semibold text-xs tabular-nums", className)}>{value}</span>
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* Rail                                                                       */
/* -------------------------------------------------------------------------- */

function Rail({ summary }: { summary: SessionSummary }) {
	// The header resolves the same set, so the two share one batch.
	const detect = useDetectedModels(summary.models.map((model) => model.model))
	const tokenBuckets = TOKEN_BUCKETS.filter((bucket) => summary.tokens[bucket.key] > 0)
	const topModelCost = Math.max(...summary.models.map((model) => model.cost ?? 0), 0)

	return (
		<aside className="flex shrink-0 flex-col gap-6 @4xl:w-[21rem] @4xl:border-border @4xl:border-l @4xl:pl-8">
			<RailSection
				title="Cost by model"
				aside={
					summary.cost === undefined ? undefined : (
						<span className="font-mono text-primary text-xs">{formatCost(summary.cost)}</span>
					)
				}
			>
				{summary.models.length === 0 ? (
					<p className="text-muted-foreground text-xs">no model calls</p>
				) : (
					summary.models.map((model) => (
						<div key={model.model} className="space-y-1.5">
							<div className="flex items-baseline justify-between gap-2">
								<ModelLabel detected={detect(model.model)} size={12} className="text-xs" />
								<span className="shrink-0 font-mono text-muted-foreground text-xs">
									{model.cost === undefined ? "no cost" : formatCost(model.cost)} ·{" "}
									{model.llmCalls} {model.llmCalls === 1 ? "call" : "calls"}
								</span>
							</div>
							{model.cost !== undefined && topModelCost > 0 && (
								<div className="h-1 w-full overflow-hidden rounded-xs bg-muted">
									<div
										className="h-full bg-primary"
										style={{
											width: `${sharePercent(model.cost, topModelCost)}%`,
										}}
									/>
								</div>
							)}
						</div>
					))
				)}
				{/* Cost is only ever what an instrumentation stamped on a span — Maple
				    prices nothing itself, and saying so is the difference between a
				    figure and a bill. */}
				<p className="text-[11px] text-muted-foreground leading-relaxed">
					{summary.cost === undefined
						? "No span reported a cost. Maple does not price tokens itself."
						: "As reported by the instrumentation. Not a bill."}
				</p>
			</RailSection>

			<RailSection
				title="Tokens"
				aside={
					summary.tokens.total > 0 ? (
						<span className="font-mono text-xs">{formatNumber(summary.tokens.total)}</span>
					) : undefined
				}
			>
				{summary.tokens.total === 0 ? (
					<p className="text-muted-foreground text-xs">no token usage reported</p>
				) : (
					<>
						<div className="flex h-2 w-full gap-px overflow-hidden rounded-xs bg-muted">
							{tokenBuckets.map((bucket) => (
								<div
									key={bucket.key}
									className={bucket.fill}
									style={{
										width: `${sharePercent(summary.tokens[bucket.key], summary.tokens.total)}%`,
									}}
								/>
							))}
						</div>
						{tokenBuckets.map((bucket) => (
							<div key={bucket.key} className="flex items-center gap-2.5">
								<bucket.icon aria-hidden size={13} className={cn("shrink-0", bucket.text)} />
								<span className="min-w-0 flex-1 truncate text-xs">{bucket.label}</span>
								<span className="font-mono text-muted-foreground text-xs tabular-nums">
									{formatNumber(summary.tokens[bucket.key])}
								</span>
							</div>
						))}
						{summary.tokenReporting === "session-level" && (
							<p className="text-[11px] text-muted-foreground">
								Reported once for the whole session
							</p>
						)}
					</>
				)}
			</RailSection>

			{/* Two sections, not one: who ran and what they reached for are
			    different questions, and a reader scanning for one should not have
			    to read past the other. */}
			{summary.agentNames.length > 0 && (
				<RailSection title="Agents">
					<div className="flex flex-wrap items-center gap-2">
						{summary.agentNames.map((name, index) => (
							// `min-w-0 max-w-full` + truncate: an agent name is emitter
							// input, and one long enough would otherwise push the whole
							// page into a horizontal scroll.
							<span key={name} className="flex min-w-0 max-w-full items-center gap-2">
								{index > 0 && (
									<ArrowRightIcon size={12} className="shrink-0 text-muted-foreground" />
								)}
								<span
									className={cn(
										"min-w-0 truncate rounded-sm px-2 py-0.5 font-mono text-[11px]",
										index === 0
											? "bg-primary/12 text-primary"
											: "bg-muted text-muted-foreground",
									)}
									title={name}
								>
									{name}
								</span>
							</span>
						))}
					</div>
				</RailSection>
			)}
		</aside>
	)
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the session reached for, as a ledger rather than a ranking.
 *
 * The bar chart this replaced answered only "which tool was called most", a
 * question nobody asks, and spent a row of the page on each answer. The columns
 * here are the ones an engineer actually arrives with — which tool burned the
 * time, which is flaky, which the agent kept re-running — and the lane beside
 * them puts every call on the session's own clock, so a row also says *when*. A
 * mark is a call: clicking it opens that span.
 */
function ToolUsage({ summary, onOpenSpan }: { summary: SessionSummary; onOpenSpan: OpenSpan }) {
	const [expanded, setExpanded] = useState<string | undefined>(undefined)
	const axis = useMemo(
		() => buildSessionAxis({ startMs: summary.startMs, endMs: summary.endMs, collapsedGaps: [] }),
		[summary.startMs, summary.endMs],
	)

	const toggle = (key: string) => setExpanded((current) => (current === key ? undefined : key))

	return (
		<section className="flex flex-col gap-3">
			<ToolLedgerHeader summary={summary} />

			{summary.tools.length === 0 ? (
				<p className="text-muted-foreground text-xs">no tool calls</p>
			) : (
				<>
					<div className="flex flex-col">
						<ToolLedgerColumns axis={axis} />
						{summary.tools.map((tool) => (
							<ToolLedgerRow
								key={tool.name}
								tool={tool}
								axis={axis}
								sessionStartMs={summary.startMs}
								expanded={expanded === tool.name}
								onToggle={() => toggle(tool.name)}
								onOpenSpan={onOpenSpan}
							/>
						))}
					</div>
				</>
			)}
		</section>
	)
}

function ToolLedgerHeader({ summary }: { summary: SessionSummary }) {
	const calls = summary.tools.reduce((total, tool) => total + tool.calls, 0)
	const failed = summary.tools.reduce((total, tool) => total + tool.failed, 0)
	const toolMs = summary.tools.reduce((total, tool) => total + tool.totalMs, 0)

	return (
		<div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
			<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
				Tools
			</h3>
			{summary.tools.length > 0 && (
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<LedgerStat label="Distinct" value={formatNumber(summary.tools.length)} />
					<LedgerStat label="Calls" value={formatNumber(calls)} />
					<LedgerStat label="Tool time" value={formatToolDuration(toolMs)} tone="text-chart-4" />
					{failed > 0 && (
						<span className="flex items-baseline gap-1.5 rounded-sm bg-destructive/12 px-1.5 py-0.5">
							<span className="font-mono font-semibold text-destructive text-xs tabular-nums">
								{failed}
							</span>
							<span className="text-[11px] text-destructive">failed</span>
						</span>
					)}
				</div>
			)}
		</div>
	)
}

function LedgerStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
	return (
		<span className="flex items-baseline gap-1.5">
			<span className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
				{label}
			</span>
			<span className={cn("font-mono font-semibold text-xs tabular-nums", tone ?? "text-foreground")}>
				{value}
			</span>
		</span>
	)
}

/** The ledger's lanes, shared by the column header and every row: a column is
 *  read downwards, so the widths are fixed rather than content-driven. */
const LEDGER_NAME = "w-44 min-w-0 shrink-0"
const LEDGER_COUNT = "w-11 shrink-0 text-right"
const LEDGER_TIME = "w-16 shrink-0 text-right"

function ToolLedgerColumns({ axis }: { axis: SessionAxis }) {
	return (
		<div className="flex items-end gap-4 border-border border-b pb-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
			<span className={LEDGER_NAME}>Tool</span>
			<span className={LEDGER_COUNT}>Calls</span>
			<span className={LEDGER_COUNT}>Fail</span>
			<span className={LEDGER_TIME}>Total</span>
			<span className={LEDGER_TIME}>Slowest</span>
			<span className="relative h-3.5 min-w-0 grow">
				{axis.ticks.map((tick) =>
					tick.fraction === 0 ? null : (
						<span
							key={tick.label}
							// The last tick anchors to the axis end rather than centring on
							// it: a centred one would hang off the column.
							className={cn(
								"absolute top-0 whitespace-nowrap font-mono font-normal text-[10px] normal-case tracking-normal",
								tick.fraction < 0.92 && "-translate-x-1/2",
							)}
							style={
								tick.fraction < 0.92
									? { left: `${tick.fraction * 100}%` }
									: { right: `${(1 - tick.fraction) * 100}%` }
							}
						>
							{tick.label}
						</span>
					),
				)}
			</span>
		</div>
	)
}

/**
 * One tool. Expanding it discloses what the rail used to hide — the definition
 * the model was given, and every call that failed, with its error and a way into
 * the span — so the row is both the summary and the way in.
 */
function ToolLedgerRow({
	tool,
	axis,
	sessionStartMs,
	expanded,
	onToggle,
	onOpenSpan,
}: {
	tool: SessionToolUsage
	axis: SessionAxis
	sessionStartMs: number
	expanded: boolean
	onToggle: () => void
	onOpenSpan: OpenSpan
}) {
	const failures = tool.events.filter((event) => event.failed)
	const disclosable = tool.description !== undefined || failures.length > 0

	return (
		<div className={cn("flex flex-col", tool.failed > 0 && "bg-destructive/[0.06]")}>
			<div className="flex h-6 items-center gap-4">
				{disclosable ? (
					<button
						type="button"
						onClick={onToggle}
						aria-expanded={expanded}
						className={cn(
							LEDGER_NAME,
							"flex cursor-pointer items-center gap-1.5 text-left hover:text-primary",
						)}
					>
						<ChevronRightIcon
							aria-hidden
							size={9}
							className={cn("shrink-0 transition-transform", expanded && "rotate-90")}
						/>
						<span className="min-w-0 truncate font-mono text-xs" title={tool.name}>
							{tool.name}
						</span>
					</button>
				) : (
					<span
						className={cn(LEDGER_NAME, "truncate pl-[15px] font-mono text-xs")}
						title={tool.name}
					>
						{tool.name}
					</span>
				)}
				<span className={cn(LEDGER_COUNT, "font-mono text-xs tabular-nums")}>{tool.calls}</span>
				<span
					className={cn(
						LEDGER_COUNT,
						"font-mono text-xs tabular-nums",
						tool.failed > 0 ? "text-destructive" : "text-muted-foreground/50",
					)}
				>
					{tool.failed > 0 ? tool.failed : "."}
				</span>
				<span className={cn(LEDGER_TIME, "font-mono text-xs tabular-nums")}>
					{formatToolDuration(tool.totalMs)}
				</span>
				<span className={cn(LEDGER_TIME, "font-mono text-muted-foreground text-xs tabular-nums")}>
					{formatToolDuration(tool.slowestMs)}
				</span>
				<CallLane
					events={tool.events}
					axis={axis}
					sessionStartMs={sessionStartMs}
					toolName={tool.name}
					onOpenSpan={onOpenSpan}
				/>
			</div>

			{expanded && (
				<div className="flex flex-col gap-2 py-2 pr-3 pl-[15px]">
					{tool.description !== undefined && (
						<p className="max-w-[70ch] text-muted-foreground text-xs leading-relaxed">
							{tool.description}
						</p>
					)}
					{failures.map((event) => (
						<FailedCallRow
							key={event.spanId}
							event={event}
							sessionStartMs={sessionStartMs}
							onOpenSpan={onOpenSpan}
						/>
					))}
				</div>
			)}
		</div>
	)
}

/** Every call of a tool on the session's clock. The hairline is the session, a
 *  mark is a call; a mark thinner than 3px would otherwise vanish. */
function CallLane({
	events,
	axis,
	sessionStartMs,
	toolName,
	muted = false,
	onOpenSpan,
}: {
	events: readonly SessionToolCall[]
	axis: SessionAxis
	sessionStartMs: number
	toolName: string
	muted?: boolean
	onOpenSpan: OpenSpan
}) {
	return (
		<span className="relative h-6 min-w-0 grow">
			<span aria-hidden className="absolute top-1/2 left-0 h-px w-full bg-border" />
			{events.map((event) => (
				<button
					key={event.spanId}
					type="button"
					aria-haspopup="dialog"
					onClick={() => onOpenSpan(event.spanId)}
					title={callTitle(toolName, event, sessionStartMs)}
					className={cn(
						"absolute cursor-pointer rounded-[1px]",
						event.failed
							? "top-[5px] h-3.5 bg-destructive"
							: muted
								? "top-2 h-2 bg-muted-foreground/50"
								: "top-[7px] h-2.5 bg-chart-4",
					)}
					style={{
						// A call at the very end would draw its minimum width past the
						// lane, so the mark is held inside it.
						left: `min(${axis.fraction(event.startMs) * 100}%, 100% - 3px)`,
						width: `max(3px, ${(event.durationMs / axis.totalMs) * 100}%)`,
					}}
				>
					<span className="sr-only">{callTitle(toolName, event, sessionStartMs)}</span>
				</button>
			))}
		</span>
	)
}

/** A failed call, spelled out under its tool: what the instrumentation called
 *  it, where in the session it happened, and the way into the span. */
function FailedCallRow({
	event,
	sessionStartMs,
	onOpenSpan,
}: {
	event: SessionToolCall
	sessionStartMs: number
	onOpenSpan: OpenSpan
}) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-destructive border-l-2 bg-destructive/[0.06] py-1.5 pr-2 pl-2.5">
			<span className="font-medium font-mono text-destructive text-xs">
				{event.errorLabel ?? "error"}
			</span>
			<span className="font-mono text-muted-foreground text-xs">{callWhen(event, sessionStartMs)}</span>
			{event.errorDetail !== undefined && (
				<span className="min-w-0 text-muted-foreground text-xs">{event.errorDetail}</span>
			)}
			<Button
				variant="link"
				size="sm"
				aria-haspopup="dialog"
				onClick={() => onOpenSpan(event.spanId)}
				className="ml-auto h-auto p-0 text-xs"
			>
				Open span
				<ArrowRightIcon size={11} />
			</Button>
		</div>
	)
}

function callWhen(event: SessionToolCall, sessionStartMs: number): string {
	// A call can start on the session's own first instant, and the session
	// formatter spells a zero as an em dash — which reads as "no offset known"
	// rather than "at the start".
	const offsetMs = event.startMs - sessionStartMs
	const at = `${offsetMs <= 0 ? "0s" : formatSessionDuration(offsetMs)} in, ${formatToolDuration(event.durationMs)}`
	return event.turnIndex === undefined ? at : `turn ${event.turnIndex}, ${at}`
}

function callTitle(toolName: string, event: SessionToolCall, sessionStartMs: number): string {
	const where = `${toolName} — ${callWhen(event, sessionStartMs)}`
	return event.failed ? `${where} — ${event.errorLabel ?? "error"}` : where
}

/**
 * Tool durations run from a tenth of a second to minutes and the ledger compares
 * them column-wise, so seconds keep a decimal and minutes drop it.
 */
function formatToolDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatSessionDuration(ms)
}

function RailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3 border-border border-t pt-6 first:border-t-0 first:pt-0">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					{title}
				</h3>
				{aside}
			</div>
			{children}
		</section>
	)
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function sharePercent(value: number, total: number): number {
	if (total <= 0) return 0
	return (value / total) * 100
}
