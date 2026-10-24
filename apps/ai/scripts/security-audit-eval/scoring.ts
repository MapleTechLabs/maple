/**
 * Case files, run metrics, scoring and aggregation for `security:eval`. Pure: the script does the
 * I/O. Verdicts come from explicit human grades; location overlap only suggests what to grade.
 */
import { Findings } from "@maple/security-audit"
import { Schema } from "effect"

export const Language = Schema.Literals(["typescript", "javascript", "python", "go", "rust", "java"])
export type Language = typeof Language.Type

export const Profile = Schema.Literals(["quick", "standard", "deep"])
export type Profile = typeof Profile.Type

/** One labelled bug. The run's commit must not contain `fixSha`. */
export const KnownBug = Schema.Struct({
	id: Schema.String,
	/** A pull request (`MapleTechLabs/maple#712`) or a public advisory id (GHSA/CVE). */
	reference: Schema.String,
	fixSha: Schema.String,
	/** Non-test files the fix changed: where a matching record should point. */
	touchedFiles: Schema.Array(Schema.String),
})
export type KnownBug = typeof KnownBug.Type

/** One audit run: a repository at one commit, scoped to a slice, with the known bugs inside it. */
export const EvalCase = Schema.Struct({
	id: Schema.String,
	corpus: Schema.Literals(["maple", "public"]),
	language: Language,
	repo: Schema.Struct({ name: Schema.String, url: Schema.String }),
	sha: Schema.String,
	scope: Schema.Array(Schema.String),
	bugs: Schema.NonEmptyArray(KnownBug),
	profile: Schema.optionalKey(Profile),
	budget: Schema.optionalKey(Schema.Int),
	concurrency: Schema.optionalKey(Schema.Int),
})
export type EvalCase = typeof EvalCase.Type

export const CaseFile = Schema.Struct({
	defaults: Schema.Struct({ profile: Profile, budget: Schema.Int, concurrency: Schema.Int }),
	cases: Schema.Array(EvalCase),
})
export type CaseFile = typeof CaseFile.Type

/** One line of the runner's `events.jsonl`; only agent outcomes and usage matter here. */
export const EventLine = Schema.Struct({
	_tag: Schema.String,
	at: Schema.String,
	outcome: Schema.optionalKey(Schema.String),
	usage: Schema.optionalKey(
		Schema.Struct({
			inputTokens: Schema.Number,
			outputTokens: Schema.Number,
			costUsd: Schema.optionalKey(Schema.Number),
		}),
	),
})
export type EventLine = typeof EventLine.Type

export const RunMetrics = Schema.Struct({
	status: Schema.String,
	invocations: Schema.Int,
	agentsOk: Schema.Int,
	agentsDiscarded: Schema.Int,
	agentsFailed: Schema.Int,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	costUsd: Schema.Number,
	wallClockSeconds: Schema.Number,
	confirmed: Schema.Int,
	needsValidation: Schema.Int,
	rejected: Schema.Int,
	/** needs_validation records whose every blocker is the missing execution sandbox. */
	needsValidationExecutionOnly: Schema.Int,
})
export type RunMetrics = typeof RunMetrics.Type

export const LocationMatch = Schema.Struct({
	bug: Schema.String,
	fingerprint: Schema.String,
	verdict: Schema.String,
	title: Schema.String,
	files: Schema.Array(Schema.String),
})
export type LocationMatch = typeof LocationMatch.Type

/** What one finished run left behind, written beside its run directory. */
export const CaseResult = Schema.Struct({
	key: Schema.String,
	case: EvalCase,
	profile: Profile,
	budget: Schema.Int,
	exitCode: Schema.Int,
	metrics: RunMetrics,
	locationMatches: Schema.Array(LocationMatch),
	/** Model overrides the run used; null means the runner's default for that stage. */
	models: Schema.optionalKey(
		Schema.Struct({ discovery: Schema.NullOr(Schema.String), validation: Schema.NullOr(Schema.String) }),
	),
})
export type CaseResult = typeof CaseResult.Type

export const BugVerdict = Schema.Literals(["hit-confirmed", "hit-needs-validation", "miss", "wrong-location"])
export type BugVerdict = typeof BugVerdict.Type

export const SpotClass = Schema.Literals(["real", "plausible", "false-positive"])
export type SpotClass = typeof SpotClass.Type

/** Human grades: per known bug, which records are it; per unrelated record spot-checked, a class. */
export const Grades = Schema.Struct({
	bugs: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			bug: Schema.String,
			verdict: Schema.optionalKey(BugVerdict),
			matched: Schema.optionalKey(Schema.Array(Schema.String)),
			missReason: Schema.optionalKey(Schema.String),
			notes: Schema.optionalKey(Schema.String),
		}),
	),
	spotChecks: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			fingerprint: Schema.String,
			class: SpotClass,
			notes: Schema.optionalKey(Schema.String),
		}),
	),
})
export type Grades = typeof Grades.Type
export type BugGrade = Grades["bugs"][number]

export const decodeCaseFile = Schema.decodeUnknownSync(CaseFile)
export const decodeEventLine = Schema.decodeUnknownSync(EventLine)
export const decodeFindings = Schema.decodeUnknownSync(Findings)
export const decodeCaseResult = Schema.decodeUnknownSync(CaseResult)
export const decodeGrades = Schema.decodeUnknownSync(Grades)
/** The one field of the runner's `run-metadata.json` the eval reads. */
export const decodeRunStatus = Schema.decodeUnknownSync(Schema.Struct({ run_status: Schema.String }))

export type Finding = (typeof Findings.Type)[number]

const EXECUTION_BLOCKER =
	/execut|sandbox|(could|can)not (be )?run|not run|unable to run|no (local )?runtime|dynamic|reproduc|poc|proof of concept|test harness|run the/i

/** A record left unvalidated only because nothing could run: every blocker names execution. */
export const isExecutionOnly = (finding: Finding): boolean =>
	finding.verdict === "needs_validation" &&
	finding.blockers.length > 0 &&
	finding.blockers.every((blocker) => EXECUTION_BLOCKER.test(blocker))

const ZERO_USAGE = {
	agentsOk: 0,
	agentsDiscarded: 0,
	agentsFailed: 0,
	inputTokens: 0,
	outputTokens: 0,
	costUsd: 0,
}

export const usageOf = (events: ReadonlyArray<EventLine>) =>
	events
		.filter((event) => event._tag === "Agent")
		.reduce(
			(acc, event) => ({
				agentsOk: acc.agentsOk + (event.outcome === "ok" ? 1 : 0),
				agentsDiscarded: acc.agentsDiscarded + (event.outcome === "discarded" ? 1 : 0),
				agentsFailed: acc.agentsFailed + (event.outcome === "failed" ? 1 : 0),
				inputTokens: acc.inputTokens + (event.usage?.inputTokens ?? 0),
				outputTokens: acc.outputTokens + (event.usage?.outputTokens ?? 0),
				costUsd: acc.costUsd + (event.usage?.costUsd ?? 0),
			}),
			ZERO_USAGE,
		)

export const metricsOf = (input: {
	readonly status: string
	readonly events: ReadonlyArray<EventLine>
	readonly findings: ReadonlyArray<Finding>
	readonly wallClockSeconds: number
}): RunMetrics => {
	const usage = usageOf(input.events)
	const count = (verdict: Finding["verdict"]) => input.findings.filter((f) => f.verdict === verdict).length
	return {
		status: input.status,
		invocations: usage.agentsOk + usage.agentsDiscarded + usage.agentsFailed,
		...usage,
		wallClockSeconds: input.wallClockSeconds,
		confirmed: count("confirmed"),
		needsValidation: count("needs_validation"),
		rejected: count("rejected"),
		needsValidationExecutionOnly: input.findings.filter(isExecutionOnly).length,
	}
}

const TEST_PATH =
	/(^|\/)(__tests__|tests?|__fixtures__|functional-tests)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.java$/

export const isTestPath = (path: string) => TEST_PATH.test(path)

const normalize = (path: string) => path.replace(/^\.?\//, "").replace(/:\d+(-\d+)?$/, "")

export const filesOf = (finding: Finding): ReadonlyArray<string> => [
	...new Set(
		[...finding.trace.map((step) => step.file), ...finding.evidence.map((e) => e.file)].map(normalize),
	),
]

/** Records touching a file a bug's fix changed, most overlap first: what a human grades first. */
export const locationMatches = (
	findings: ReadonlyArray<Finding>,
	bugs: ReadonlyArray<KnownBug>,
): ReadonlyArray<LocationMatch> =>
	bugs.flatMap((bug) => {
		const touched = new Set(bug.touchedFiles.filter((path) => !isTestPath(path)).map(normalize))
		return findings
			.map((finding) => ({
				bug: bug.id,
				fingerprint: finding.fingerprint,
				verdict: finding.verdict,
				title: finding.title,
				files: filesOf(finding).filter((file) => touched.has(file)),
			}))
			.filter((match) => match.files.length > 0)
			.sort((a, b) => b.files.length - a.files.length)
	})

export type ScoredVerdict = BugVerdict | "unscored"

export interface ScoredBug {
	readonly key: string
	readonly bug: string
	readonly reference: string
	readonly language: Language
	readonly corpus: EvalCase["corpus"]
	readonly verdict: ScoredVerdict
	readonly missReason: string | undefined
}

export interface ScoredRun {
	readonly key: string
	readonly caseId: string
	readonly corpus: EvalCase["corpus"]
	readonly language: Language
	readonly profile: Profile
	readonly budget: number
	readonly bugs: ReadonlyArray<ScoredBug>
	/** Non-rejected records that are none of the run's known bugs. */
	readonly unrelated: number
	readonly spotChecks: Readonly<Record<SpotClass, number>>
	readonly metrics: RunMetrics
}

const VERDICT_RANK = { confirmed: 2, needs_validation: 1, rejected: 0 } satisfies Record<
	Finding["verdict"],
	number
>

/**
 * A bug's verdict: explicit when graded so, else the strongest verdict among its matched records.
 * A known bug that only appears as a rejected record is a miss: the engine saw it and dismissed it.
 */
export const scoreBug = (findings: ReadonlyArray<Finding>, grade: BugGrade | undefined) => {
	if (grade === undefined) return { verdict: "unscored" as const, missReason: undefined }
	const matched = new Set(grade.matched ?? [])
	const best = findings
		.filter((f) => matched.has(f.fingerprint))
		.reduce<Finding | undefined>(
			(top, f) => (top === undefined || VERDICT_RANK[f.verdict] > VERDICT_RANK[top.verdict] ? f : top),
			undefined,
		)
	const verdict: BugVerdict =
		grade.verdict ??
		(best?.verdict === "confirmed"
			? "hit-confirmed"
			: best?.verdict === "needs_validation"
				? "hit-needs-validation"
				: "miss")
	const missReason =
		grade.missReason ??
		(verdict === "miss" && best?.verdict === "rejected" ? "dismissed-by-validation" : undefined)
	return { verdict, missReason }
}

export const scoreRun = (result: CaseResult, findings: ReadonlyArray<Finding>, grades: Grades): ScoredRun => {
	const bugGrades = grades.bugs.filter((g) => g.key === result.key)
	const matchedAll = new Set(bugGrades.flatMap((g) => g.matched ?? []))
	const spot = grades.spotChecks
		.filter((check) => check.key === result.key)
		.reduce((acc, check) => ({ ...acc, [check.class]: acc[check.class] + 1 }), {
			real: 0,
			plausible: 0,
			"false-positive": 0,
		})
	return {
		key: result.key,
		caseId: result.case.id,
		corpus: result.case.corpus,
		language: result.case.language,
		profile: result.profile,
		budget: result.budget,
		bugs: result.case.bugs.map((bug) => ({
			key: result.key,
			bug: bug.id,
			reference: bug.reference,
			language: result.case.language,
			corpus: result.case.corpus,
			...scoreBug(
				findings,
				bugGrades.find((g) => g.bug === bug.id),
			),
		})),
		unrelated: findings.filter((f) => f.verdict !== "rejected" && !matchedAll.has(f.fingerprint)).length,
		spotChecks: spot,
		metrics: result.metrics,
	}
}

export interface AggregateRow {
	readonly group: string
	readonly runs: number
	readonly bugs: number
	readonly hitConfirmed: number
	readonly hitNeedsValidation: number
	readonly miss: number
	readonly wrongLocation: number
	readonly unscored: number
	/** Hits of either kind over graded bugs; null when none is graded. */
	readonly hitRate: number | null
	readonly unrelated: number
	readonly spotReal: number
	readonly spotPlausible: number
	readonly spotFalsePositive: number
	readonly invocations: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly costUsd: number
	readonly wallClockSeconds: number
	readonly needsValidation: number
	readonly needsValidationExecutionOnly: number
}

/** Rolls runs up by group: bug verdicts counted per bug, cost and invocations per run. */
export const aggregate = (
	runs: ReadonlyArray<ScoredRun>,
	groupOf: (run: ScoredRun) => string,
): ReadonlyArray<AggregateRow> => {
	const groups = runs.reduce<ReadonlyMap<string, ReadonlyArray<ScoredRun>>>(
		(acc, run) => new Map(acc).set(groupOf(run), [...(acc.get(groupOf(run)) ?? []), run]),
		new Map(),
	)
	return [...groups.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([group, members]) => {
			const bugs = members.flatMap((m) => m.bugs)
			const n = (verdict: ScoredVerdict) => bugs.filter((b) => b.verdict === verdict).length
			const sum = (f: (m: ScoredRun) => number) => members.reduce((acc, m) => acc + f(m), 0)
			const graded = bugs.length - n("unscored")
			return {
				group,
				runs: members.length,
				bugs: bugs.length,
				hitConfirmed: n("hit-confirmed"),
				hitNeedsValidation: n("hit-needs-validation"),
				miss: n("miss"),
				wrongLocation: n("wrong-location"),
				unscored: n("unscored"),
				hitRate: graded === 0 ? null : (n("hit-confirmed") + n("hit-needs-validation")) / graded,
				unrelated: sum((m) => m.unrelated),
				spotReal: sum((m) => m.spotChecks.real),
				spotPlausible: sum((m) => m.spotChecks.plausible),
				spotFalsePositive: sum((m) => m.spotChecks["false-positive"]),
				invocations: sum((m) => m.metrics.invocations),
				inputTokens: sum((m) => m.metrics.inputTokens),
				outputTokens: sum((m) => m.metrics.outputTokens),
				costUsd: sum((m) => m.metrics.costUsd),
				wallClockSeconds: sum((m) => m.metrics.wallClockSeconds),
				needsValidation: sum((m) => m.metrics.needsValidation),
				needsValidationExecutionOnly: sum((m) => m.metrics.needsValidationExecutionOnly),
			}
		})
}

/** Expected cost of a run: its budget at the mean observed cost per invocation so far. */
export const estimateCost = (
	budget: number,
	previous: ReadonlyArray<RunMetrics>,
	fallbackPerInvocation: number,
): number => {
	const invocations = previous.reduce((acc, m) => acc + m.invocations, 0)
	const cost = previous.reduce((acc, m) => acc + m.costUsd, 0)
	return budget * (invocations === 0 ? fallbackPerInvocation : cost / invocations)
}

/** Whether another run fits under the cap, given what was spent and what it should cost. */
export const fitsCap = (spentUsd: number, estimateUsd: number, capUsd: number) =>
	spentUsd + estimateUsd <= capUsd

const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`)
const usd = (value: number) => `$${value.toFixed(2)}`

export const renderTable = (rows: ReadonlyArray<AggregateRow>) =>
	[
		"| Group | Runs | Bugs | Hit confirmed | Hit needs_validation | Miss | Wrong location | Unscored | Hit rate | Unrelated | Spot real/plausible/FP | Invocations | Input tok | Output tok | Cost | needs_validation (exec-only) |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map(
			(r) =>
				`| ${r.group} | ${r.runs} | ${r.bugs} | ${r.hitConfirmed} | ${r.hitNeedsValidation} | ${r.miss} | ${r.wrongLocation} | ${r.unscored} | ${pct(r.hitRate)} | ${r.unrelated} | ${r.spotReal}/${r.spotPlausible}/${r.spotFalsePositive} | ${r.invocations} | ${r.inputTokens} | ${r.outputTokens} | ${usd(r.costUsd)} | ${r.needsValidation} (${r.needsValidationExecutionOnly}) |`,
		),
	].join("\n")

export const renderRuns = (runs: ReadonlyArray<ScoredRun>) =>
	[
		"| Run | Lang | Profile/budget | Bugs (verdict) | Unrelated | Invocations | Wall clock | In/out tokens | Cost | C/NV/R | NV exec-only | Status |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...runs.map(
			(r) =>
				`| ${r.key} | ${r.language} | ${r.profile}/${r.budget} | ${r.bugs.map((b) => `${b.reference}: ${b.verdict}${b.missReason === undefined ? "" : ` (${b.missReason})`}`).join("; ")} | ${r.unrelated} | ${r.metrics.invocations} | ${Math.round(r.metrics.wallClockSeconds / 60)}m | ${r.metrics.inputTokens}/${r.metrics.outputTokens} | ${usd(r.metrics.costUsd)} | ${r.metrics.confirmed}/${r.metrics.needsValidation}/${r.metrics.rejected} | ${r.metrics.needsValidationExecutionOnly} | ${r.metrics.status} |`,
		),
	].join("\n")
