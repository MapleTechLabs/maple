import type { ReactNode } from "react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { SEVERITY_LABEL } from "@/components/errors/severity-badge"
import { CircleQuestionIcon, CircleXmarkIcon } from "@/components/icons"
import { useTickingNow } from "@/hooks/use-ticking-now"
import { type Elapsed, reportHeadline, splitDuration } from "./investigation-display"
import { RunProgress } from "./run-progress"
import { ConfidenceMeter } from "./confidence-meter"

/**
 * What the investigation concluded, or how far it has got trying. One card, four
 * shapes — diagnosed, running, inconclusive, failed — because they answer the
 * same question at different stages and swapping between them shouldn't move the
 * page around.
 *
 * The left edge is a 3px accent rule, so the card is square on that side: a
 * rounded corner behind a flat bar leaves a sliver of card showing above and
 * below the rule, which reads as a rendering bug.
 */
export function VerdictCard({ investigation }: { investigation: V2Investigation }) {
	if (investigation.status === "investigating") {
		return <InvestigatingVerdict investigation={investigation} />
	}
	// Before the `failed` check. These are different claims: `inconclusive` means
	// the run worked and reached "not established", `failed` means the machinery
	// broke. Rendering the first as the second is what put a raw
	// `validation_inconclusive: …` string in a destructive box on top of a run
	// that had ruled things out perfectly well.
	if (investigation.status === "inconclusive") {
		return <InconclusiveVerdict investigation={investigation} />
	}
	if (investigation.status === "failed") {
		return <FailedVerdict investigation={investigation} />
	}
	return <DiagnosedVerdict investigation={investigation} />
}

/* -------------------------------------------------------------------------------------------------
 * Shell
 * -----------------------------------------------------------------------------------------------*/

function VerdictShell({
	accent,
	children,
	stats,
}: {
	accent: string
	children: ReactNode
	stats: ReactNode
}) {
	return (
		// `shrink-0`: the page column is `min-h-full`, so without it a tall card is
		// the flex item that absorbs the shortfall and collapses to its borders
		// while its content overflows into the section below.
		// Square on whichever edge carries the accent rule — a rounded corner behind
		// a flat bar leaves a sliver of card showing past it, which reads as a
		// rendering bug. That edge is the left when the card is a row, the top once
		// it stacks.
		<div className="flex shrink-0 overflow-hidden rounded-r-xl border bg-card max-lg:flex-col max-lg:rounded-b-xl max-lg:rounded-tr-none">
			{/* The accent rule runs the full height as a column edge, but once the
			    card stacks it has to become a top edge or it caps the card at 3px. */}
			<span aria-hidden className={cn("w-[3px] shrink-0 max-lg:h-[3px] max-lg:w-full", accent)} />
			<div className="flex min-w-0 flex-1 flex-col gap-3 px-7 py-6">{children}</div>
			{/* Stacked below `lg` rather than hidden: confidence and AI severity are
			    the two things that qualify the verdict, and dropping them on a narrow
			    window leaves an unqualified claim. */}
			<div className="flex w-53 shrink-0 flex-col border-l max-lg:w-full max-lg:flex-row max-lg:flex-wrap max-lg:border-l-0 max-lg:border-t">
				{stats}
			</div>
		</div>
	)
}

function Stat({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2 px-6 py-5.5 max-lg:min-w-40 max-lg:flex-1 max-lg:border-b-0 max-lg:py-4",
				last ? null : "border-b max-lg:border-r",
			)}
		>
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<div className="text-sm">{children}</div>
		</div>
	)
}

/** A big number with a small unit riding its baseline. */
function BigStat({ value, unit }: { value: string; unit: string }) {
	return (
		<span className="flex items-baseline gap-1">
			<span className="font-display text-2xl font-semibold tracking-tight text-foreground tabular-nums">
				{value}
			</span>
			<span className="text-sm text-muted-foreground">{unit}</span>
		</span>
	)
}

function Eyebrow({ children, tone }: { children: ReactNode; tone: string }) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em]",
				tone,
			)}
		>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Diagnosed
 * -----------------------------------------------------------------------------------------------*/

function DiagnosedVerdict({ investigation }: { investigation: V2Investigation }) {
	const report = investigation.report

	if (!report) {
		return (
			<VerdictShell
				accent="bg-border"
				stats={
					<Stat label="Confidence" last>
						<ConfidenceMeter confidence={investigation.confidence} />
					</Stat>
				}
			>
				<Eyebrow tone="text-muted-foreground">No diagnosis recorded</Eyebrow>
				<p className="text-sm text-muted-foreground">
					The pass finished without attaching a report. Run it again to try for a cause.
				</p>
			</VerdictShell>
		)
	}

	const timeToDiagnosis = elapsedBetween(investigation.created_at, investigation.diagnosed_at)
	const heading = reportHeadline(report)

	return (
		<VerdictShell
			accent="bg-primary"
			stats={
				<>
					<Stat label="Confidence">
						<ConfidenceMeter confidence={report.confidence} />
					</Stat>
					<Stat label="AI severity">
						{report.severityAssessment ? (
							<span
								className={cn("font-medium", SEVERITY_TEXT_TONE[report.severityAssessment])}
							>
								{SEVERITY_LABEL[report.severityAssessment]}
							</span>
						) : (
							// The report judged no severity. "—" rather than a stand-in level,
							// which would read as an assessment nobody made.
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
					<Stat label="Time to diagnosis" last>
						{timeToDiagnosis ? (
							<BigStat value={timeToDiagnosis.value} unit={timeToDiagnosis.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-primary">Suspected cause</Eyebrow>
			{/* `headline` is the only field prompted to be one line; `reportHeadline` falls back for older reports. */}
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{heading}
			</h2>
			{/* Each body field is drawn only if the heading is not already it (older reports fall back to `summary`). */}
			<Body heading={heading} text={report.summary} />
			<Mechanism heading={heading} text={report.suspectedCause} />
			<NextActions actions={report.suggestedActions} />
		</VerdictShell>
	)
}

/** Whether a body field would only repeat the heading above it. */
const repeatsHeading = (heading: string | null, text: string): boolean =>
	text.trim().length === 0 || text.trim() === heading?.trim()

/** The summary, unless the heading fell back to being it. */
function Body({ heading, text }: { heading: string | null; text: string }) {
	if (repeatsHeading(heading, text)) return null
	return <p className="text-sm leading-6 text-muted-foreground">{text}</p>
}

/** The mechanism, set off by a rule so a reader who already believes the verdict can skip it. */
function Mechanism({ heading, text }: { heading: string | null; text: string }) {
	if (repeatsHeading(heading, text)) return null
	return (
		<div className="mt-1 border-l-2 pl-4">
			<p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{text}</p>
		</div>
	)
}

/** Suggested actions on the card; they used to be reachable only as graph nodes behind a click. */
function NextActions({ actions }: { actions: ReadonlyArray<string> }) {
	if (actions.length === 0) return null
	return (
		<div className="mt-2 flex flex-col gap-2.5 border-t pt-4">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				What to do
			</span>
			{/* Ordered, because the report is prompted for ordered steps. */}
			<ol className="flex flex-col gap-2">
				{actions.map((action, index) => (
					<li key={index} className="flex gap-3 text-sm leading-6 text-foreground">
						<span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">
							{index + 1}
						</span>
						<span className="min-w-0">{action}</span>
					</li>
				))}
			</ol>
		</div>
	)
}

/** The badge tones are backgrounds; the stat column wants the text colour alone. */
const SEVERITY_TEXT_TONE: Record<string, string> = {
	critical: "text-destructive",
	high: "text-destructive",
	medium: "text-severity-warn",
	low: "text-muted-foreground",
	unclassified: "text-muted-foreground",
} satisfies Record<string, string>

/* -------------------------------------------------------------------------------------------------
 * Investigating
 * -----------------------------------------------------------------------------------------------*/

function InvestigatingVerdict({ investigation }: { investigation: V2Investigation }) {
	return (
		<VerdictShell
			accent="bg-primary"
			stats={
				<>
					<Stat label="Elapsed">
						<LiveElapsedStat from={investigation.created_at} />
					</Stat>
					<Stat label="Confidence" last>
						<span className="text-muted-foreground">Pending</span>
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-primary">
				<span className="flex items-center gap-1.5">
					<span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
					Investigating
				</span>
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				Maple is gathering evidence.
			</h2>
			<p className="text-sm leading-6 text-muted-foreground">
				One agent is working this question: reading the traces, logs and metrics around it and testing
				the likely explanations.
			</p>
			<RunProgress investigation={investigation} className="mt-1 border-t pt-4" />
		</VerdictShell>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Failed
 * -----------------------------------------------------------------------------------------------*/

function FailedVerdict({ investigation }: { investigation: V2Investigation }) {
	// From `started_at`, not `created_at`: a restart re-stamps the former, and
	// measuring from the latter reported a 20-day-old investigation as a
	// 480-hour run.
	const ranFor = elapsedBetween(
		investigation.started_at ?? investigation.created_at,
		investigation.updated_at,
	)

	return (
		<VerdictShell
			accent="bg-destructive"
			stats={
				<>
					<Stat label="Ran for">
						{ranFor ? (
							<BigStat value={ranFor.value} unit={ranFor.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
					<Stat label="Confidence" last>
						<span className="text-muted-foreground">None</span>
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-destructive">No diagnosis</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				The pass ended without a diagnosis
			</h2>
			<p className="text-sm leading-6 text-muted-foreground">
				No report was recorded. Retry to run the pass again.
			</p>
			{/* The raw error was on the wire and rendered nowhere but a toast. */}
			{investigation.error ? (
				<div className="flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5">
					<span className="shrink-0 rounded-sm bg-destructive/12 px-1.5 py-0.5 font-mono text-[11px] text-destructive">
						reason
					</span>
					<code className="min-w-0 break-words font-mono text-xs leading-5 text-foreground">
						{investigation.error}
					</code>
				</div>
			) : null}
			{/* How far the pass got: on a failed run, the only account that outlives the event stream. */}
			<RunProgress investigation={investigation} className="mt-1 border-t pt-4" />
		</VerdictShell>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Inconclusive
 * -----------------------------------------------------------------------------------------------*/

/** Above this the lists fold; the whole list is in the report on the Evidence tab. */
const PARTIAL_VISIBLE_MAX = 5

/**
 * A run that reached "not established", published as a result rather than as an
 * error.
 *
 * The editorial call that matters most is the h2: the page still leads with a
 * *sentence about the incident* — the strongest remaining lead — rather than
 * with "we could not tell". Someone opening this has an open incident, and what
 * they need first is the lead and then the list of things no longer worth their
 * time. The failed card's raw `reason` box is deliberately absent: `error` is
 * null on these rows now, and the payload that replaced it is `ruledOut` /
 * `unchecked`.
 */
function InconclusiveVerdict({ investigation }: { investigation: V2Investigation }) {
	const report = investigation.report
	// From `started_at` for the same reason the failed card is: a restart
	// re-stamps it, and measuring from `created_at` reports a 20-day-old
	// investigation as a 480-hour run.
	const ranFor = elapsedBetween(
		investigation.started_at ?? investigation.created_at,
		investigation.updated_at,
	)
	const ruledOut = report?.ruledOut ?? []
	const unchecked = report?.unchecked ?? []
	// Legacy rows backfilled to `inconclusive` have no report at all.
	const headline = reportHeadline(report) ?? "No cause was established, and this run recorded no partial."

	return (
		<VerdictShell
			// Warn, never destructive. Nothing broke — and the accent is the first
			// thing read, so it sets whether the whole card is a result or a defect.
			accent="bg-severity-warn"
			stats={
				<>
					<Stat label="Ran for">
						{ranFor ? (
							<BigStat value={ranFor.value} unit={ranFor.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
					{/* What was eliminated is the run's actual output, so it gets the stat. */}
					<Stat label="Ruled out">
						<span className="text-foreground tabular-nums">{ruledOut.length}</span>
					</Stat>
					<Stat label="Confidence" last>
						{/* A low-confidence lead is a real thing and the meter is the
						    component that says so. The word "None" would claim the run
						    produced nothing, which is the framing being removed. */}
						{report ? (
							<ConfidenceMeter confidence="low" />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-severity-warn">
				Partial result
				<span aria-hidden className="text-muted-foreground/40">
					·
				</span>
				<span>No cause established</span>
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{headline}
			</h2>
			{report ? <Body heading={headline} text={report.summary} /> : null}

			{/* Two columns above `lg`, stacked below — the shell's own breakpoint, so
			    the lists reflow with the stat rail rather than against it. */}
			{ruledOut.length > 0 || unchecked.length > 0 ? (
				<div className="mt-1 grid gap-x-8 gap-y-5 lg:grid-cols-2">
					<PartialList
						label="Ruled out"
						items={ruledOut}
						icon={
							<CircleXmarkIcon size={13} className="mt-0.5 shrink-0 text-muted-foreground/70" />
						}
						// Not struck through: these are conclusions the run reached.
						tone="text-foreground"
					/>
					<PartialList
						label="Could not check"
						items={unchecked}
						icon={
							<CircleQuestionIcon
								size={13}
								className="mt-0.5 shrink-0 text-muted-foreground/70"
							/>
						}
						tone="text-muted-foreground"
					/>
				</div>
			) : null}
		</VerdictShell>
	)
}

function PartialList({
	label,
	items,
	icon,
	tone,
}: {
	label: string
	items: ReadonlyArray<string>
	icon: ReactNode
	tone: string
}) {
	if (items.length === 0) return null
	const visible = items.slice(0, PARTIAL_VISIBLE_MAX)
	const hidden = items.length - visible.length
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<ul className="flex flex-col gap-1.5">
				{visible.map((item) => (
					<li key={item} className={cn("flex gap-2 text-sm leading-6", tone)}>
						{icon}
						<span className="min-w-0">{item}</span>
					</li>
				))}
			</ul>
			{hidden > 0 ? (
				<span className="text-xs text-muted-foreground">+{hidden} more in the report</span>
			) : null}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Elapsed helpers
 * -----------------------------------------------------------------------------------------------*/

function elapsedBetween(from: string, to: string | null): Elapsed | null {
	if (!to) return null
	const start = toEpochMs(from)
	const end = toEpochMs(to)
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
	return splitDuration(end - start)
}

/**
 * The one live number on the page. Its own component so the 1s tick re-renders
 * four characters rather than the whole verdict card.
 */
function LiveElapsedStat({ from }: { from: string }) {
	const now = useTickingNow(true)
	const start = toEpochMs(from)
	if (!Number.isFinite(start)) return <span className="text-muted-foreground">—</span>
	const { value, unit } = splitDuration(Math.max(0, now - start))
	return <BigStat value={value} unit={unit} />
}
