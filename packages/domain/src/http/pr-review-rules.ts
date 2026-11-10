/**
 * How Maple reviews a pull request, as rules over the wire types in `./pr-review`: normalizing a
 * submission, scoring and confidence, merge-step keys and ticks, reviewer mentions and commands.
 */
import { Array as Arr, Option, Schema, String as Str, Struct } from "effect"
import {
	PrReviewCategory,
	PrReviewChildDismissalSubmission,
	PrReviewCoverageSubmission,
	PrReviewCoverageUnit,
	PrReviewFinding,
	PrReviewFindingSubmission,
	PrReviewMergeStep,
	PrReviewReplyCommand,
	PrReviewReport,
	PrReviewRepositoryConfig,
	PrReviewRisk,
	PrReviewSeverity,
	PrReviewSubmission,
	PrReviewTelemetryDismissalSubmission,
	PrReviewTestSignal,
	PrReviewVerdict,
} from "./pr-review"

/**
 * The config a review of one repository runs with: the repository's fields over the
 * organization's. Instructions and ignored paths add up rather than replace, so a repository can
 * only narrow what the organization asked for. Built unchecked: the sum can pass a single field's
 * length cap, which bounds what one form saves, not what a review reads.
 */
export const mergePrReviewConfig = (
	defaults: PrReviewRepositoryConfig | undefined,
	repository: PrReviewRepositoryConfig,
): PrReviewRepositoryConfig => {
	if (defaults === undefined) return repository
	const instructions = Arr.filter(
		Arr.map([defaults.instructions, repository.instructions], (text) => trimmed(text)),
		(text): text is string => text !== undefined && text !== "",
	)
	const ignorePaths = [...new Set([...(defaults.ignorePaths ?? []), ...(repository.ignorePaths ?? [])])]
	const pick = <K extends keyof PrReviewRepositoryConfig>(key: K) =>
		repository[key] !== undefined
			? { [key]: repository[key] }
			: defaults[key] !== undefined
				? { [key]: defaults[key] }
				: undefined
	return new PrReviewRepositoryConfig(
		{
			...(instructions.length > 0 ? { instructions: Arr.join(instructions, "\n\n") } : undefined),
			...(ignorePaths.length > 0 ? { ignorePaths } : undefined),
			...pick("categories"),
			...pick("minInlineSeverity"),
			...pick("reviewDrafts"),
			...pick("reviewExternalContributors"),
			...pick("dailyLimit"),
			...pick("automaticReviewLimit"),
			...pick("feedbackScope"),
			...pick("blockOnContractBreaks"),
			...pick("postMergeCheck"),
		},
		{ disableChecks: true },
	)
}

/**
 * A step's identity across pushes: the kind and what it is about, or its wording for a reviewer
 * step without a subject. A tick is stored against this key, so it survives a new review comment.
 */
export const mergeStepKey = (step: Pick<PrReviewMergeStep, "kind" | "subject" | "title">): string => {
	const about = step.subject ?? titleSlug(step.title)
	// It is written into an HTML comment: no whitespace, no `--`, no `>`.
	return `${step.kind}:${Str.replace(/>/g, "")(Str.replace(/-{2,}/g, "-")(Str.replace(/\s+/g, "_")(about)))}`
}

const SLUG_MAX = 80

/** FNV-1a of the text, as 8 hex digits: a stable tag for wording a slug cannot tell apart. */
const fnv1a = (text: string): string =>
	Str.padStart(
		8,
		"0",
	)(
		Arr.reduce(
			Array.from(text),
			0x811c9dc5,
			(hash, char) =>
				Math.imul(hash ^ Option.getOrElse(Str.codePointAt(char, 0), () => 0), 0x01000193) >>> 0,
		).toString(16),
	)

/**
 * A reviewer step's title as a key. Split and joined rather than trimmed with `^-+|-+$`, which
 * backtracks on long runs of `-`. A slug cut for length, or one with no ASCII word left, carries a
 * hash of the whole title, so two titles that differ only past the cut or only in non-ASCII words
 * never share a key.
 */
const titleSlug = (title: string): string => {
	const slug = Arr.join(Arr.filter(Str.split(/[^a-z0-9]+/)(Str.toLowerCase(title)), Str.isNonEmpty), "-")
	if (slug.length === 0) return fnv1a(Str.trim(title))
	if (slug.length <= SLUG_MAX && !/\P{ASCII}/u.test(title)) return slug
	return `${Str.slice(0, SLUG_MAX - 9)(slug)}-${fnv1a(Str.trim(title))}`
}

/** How every review comment starts: `<!-- maple-pr-review <reviewId> <attempt> -->`. */
export const PR_REVIEW_COMMENT_MARKER_PREFIX = "<!-- maple-pr-review "

/** The hidden tag after a rendered step, so a tick is read by key rather than by wording. */
export const mergeStepTag = (key: string): string => `<!-- ms:${key} -->`

const TICK_LINE = /^\s*[-*] \[([ xX])\] .*<!-- ms:(\S+) -->\s*$/

/** The task-list state of every tagged step in a comment body. */
export const parseMergeStepTicks = (body: string): ReadonlyMap<string, boolean> =>
	new Map(
		Arr.getSomes(
			Arr.map(Str.split("\n")(body), (line) =>
				Option.flatMap(Option.fromNullishOr(TICK_LINE.exec(line)), ([, box, key]) =>
					key === undefined ? Option.none() : Option.some([key, box !== " "] as const),
				),
			),
		),
	)

/**
 * The steps an edit ticked or unticked: tagged in both bodies with a different state. A step only
 * one body holds is not a tick, and neither is an edit that left every box alone.
 */
export const mergeStepTickChanges = (
	before: string,
	after: string,
): ReadonlyArray<{ readonly key: string; readonly done: boolean }> => {
	const was = parseMergeStepTicks(before)
	return Arr.getSomes(
		Arr.map([...parseMergeStepTicks(after)], ([key, done]) =>
			Option.flatMap(Option.fromNullishOr(was.get(key)), (previous) =>
				previous === done ? Option.none() : Option.some({ key, done }),
			),
		),
	)
}
const isVerdict = Schema.is(PrReviewVerdict)
const isSeverity = Schema.is(PrReviewSeverity)
const isCategory = Schema.is(PrReviewCategory)
const isTestSignal = Schema.is(PrReviewTestSignal)
const isRisk = Schema.is(PrReviewRisk)

/** A finding the review can post: it names a file and a line, and says what is wrong. */
const MAX_FINDINGS = 50
const MAX_COVERAGE = 50
const MAX_TEXT = 4_000
const MAX_SUMMARY = 800
const MAX_KEY_CHANGES = 4
const MAX_CHECKED = 3
const MAX_BEFORE_MERGE = 6
const MAX_BULLET = 200
/** Removed names the reviewer may claim are still emitted; one per contract break is plenty. */
const MAX_DISMISSALS = 20

/** The `maple-audit` check id grammar: a family and a number, or the REN-DUAL-style suffixes. */
const AUDIT_CHECK_ID = /^(RES|STAT|SPAN|MAP|REN|LOG|MET|NAME|PII|LLM|TEL)-(\d{1,2}|[A-Z]+)$/

const toNumber = (value: number | string | null | undefined): number | undefined => {
	const n = typeof value === "string" ? Number(Str.trim(value)) : value
	return n === undefined || n === null || !Number.isFinite(n) ? undefined : n
}

const toBoolean = (value: boolean | string | null | undefined): boolean =>
	typeof value === "string" ? Str.toLowerCase(Str.trim(value)) === "true" : value === true

const decodeFindings = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(PrReviewFindingSubmission)),
)
const decodeCoverage = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(PrReviewCoverageSubmission)),
)
const decodeHandles = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))
const decodeDismissals = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(PrReviewTelemetryDismissalSubmission)),
)
const decodeChildDismissals = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(PrReviewChildDismissalSubmission)),
)

/** A lenient list as its items; JSON text that is not a list of them reads as empty. */
const listOf = <A>(
	value: ReadonlyArray<A> | string | null | undefined,
	decode: (text: string) => Option.Option<ReadonlyArray<A>>,
): ReadonlyArray<A> => (typeof value === "string" ? Option.getOrElse(decode(value), () => []) : (value ?? []))

const trimmed = (value: string | null | undefined): string | undefined =>
	value == null ? undefined : Str.trim(value)
const trimmedPath = (value: string | null | undefined): string | undefined =>
	value == null ? undefined : Str.replace(/^\/+/, "")(Str.trim(value))
const clip = (value: string, max = MAX_TEXT) => (value.length > max ? `${Str.slice(0, max)(value)}…` : value)

/** A bullet list as trimmed, non-empty lines; a leading `-` or `*` the model added is dropped. */
const bulletsOf = (
	value: ReadonlyArray<string> | string | null | undefined,
	max: number,
): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(
			Arr.map(listOf(value, decodeHandles), (item) => Str.replace(/^[-*]\s+/, "")(Str.trim(item))),
			(item) => item !== "",
		).slice(0, max),
		(item) => clip(item, MAX_BULLET),
	)

/**
 * One submitted finding as a postable one, or `undefined` when it has no path and positive line,
 * or is an observability finding without a check id from the audit.
 */
export const normalizePrReviewFinding = (raw: PrReviewFindingSubmission): PrReviewFinding | undefined => {
	const path = trimmed(raw.path)
	const line = toNumber(raw.line)
	const rawEndLine = toNumber(raw.endLine)
	if (!path || line === undefined || line < 1) return undefined
	// An id the audit does not have would be posted onto the pull request as if it did.
	const rawCheckId = raw.checkId == null ? undefined : Str.toUpperCase(Str.trim(raw.checkId))
	const checkId = rawCheckId !== undefined && AUDIT_CHECK_ID.test(rawCheckId) ? rawCheckId : undefined
	const category = isCategory(raw.category)
		? raw.category
		: checkId === undefined
			? "correctness"
			: Str.startsWith("PII-")(checkId)
				? "security"
				: "observability"
	if (category === "observability" && checkId === undefined) return undefined
	// Observability findings carry their audit id; a security finding keeps only a privacy one.
	const keptCheckId =
		category === "observability" ||
		(category === "security" && checkId !== undefined && Str.startsWith("PII-")(checkId))
			? checkId
			: undefined
	const startLine = Math.floor(line)
	const suggestion = trimmed(raw.suggestion)
	const endLine =
		rawEndLine !== undefined && Math.floor(rawEndLine) > startLine ? Math.floor(rawEndLine) : undefined
	return new PrReviewFinding({
		path,
		line: startLine,
		...(endLine === undefined ? undefined : { endLine }),
		category,
		...(keptCheckId === undefined ? undefined : { checkId: keptCheckId }),
		severity: isSeverity(raw.severity) ? raw.severity : "warn",
		title: clip(trimmed(raw.title) || "Review finding", 200),
		body: clip(trimmed(raw.body) || ""),
		...(suggestion ? { suggestion: clip(suggestion) } : undefined),
		// Indentation is part of the code a suggestion commits, so only trailing newlines go.
		...(typeof raw.replacement === "string" && raw.replacement.length <= MAX_TEXT
			? { replacement: Str.replace(/\n+$/, "")(raw.replacement) }
			: undefined),
	})
}

/**
 * Words a finding's body and its sketched fix may take. The posted bodies ran a median of 74 words
 * and most closed by restating the fix printed under them; past these an inline comment reads as an
 * essay. The fix goes in `suggestion` or `replacement`, never in the body.
 */
export const PR_REVIEW_FINDING_WORDS = { body: 60, suggestion: 35 } as const

const wordCount = (text: string | undefined) =>
	Arr.filter(Str.split(/\s+/)(text ?? ""), (word) => word !== "").length

/** What the reviewer is told to cut, or `undefined` for a finding within {@link PR_REVIEW_FINDING_WORDS}. */
export const overlongFinding = (finding: PrReviewFinding): string | undefined => {
	const body = wordCount(finding.body)
	const suggestion = wordCount(finding.suggestion)
	const over = [
		...(body > PR_REVIEW_FINDING_WORDS.body
			? [`its body is ${body} words, over ${PR_REVIEW_FINDING_WORDS.body}`]
			: []),
		...(suggestion > PR_REVIEW_FINDING_WORDS.suggestion
			? [`its suggestion is ${suggestion} words, over ${PR_REVIEW_FINDING_WORDS.suggestion}`]
			: []),
	]
	return over.length === 0
		? undefined
		: `${finding.path}:${finding.line} "${finding.title}": ${Arr.join(over, ", and ")}`
}

/** Most findings one review keeps; the same cap applies to what `record_finding` saves. */
export const PR_REVIEW_MAX_FINDINGS = MAX_FINDINGS

export interface NormalizedPrReviewSubmission {
	readonly report: PrReviewReport
	/** Top-level keys the model supplied, for the span. */
	readonly filled: ReadonlyArray<string>
	/** Findings dropped for no anchor line, or an observability finding with no audit check id. */
	readonly droppedFindings: number
	/** Handles of earlier findings the model says this head fixes, upper-cased and deduplicated. */
	readonly resolved: ReadonlyArray<string>
	/** Where the reviewer says each removed name is still emitted; the service verifies each one. */
	readonly telemetryDismissals: ReadonlyArray<PrReviewTelemetryDismissal>
	/** Child reviewers' findings the reviewer refuted; a dismissal without a reason is dropped. */
	readonly childDismissals: ReadonlyArray<PrReviewChildDismissal>
}

export interface PrReviewChildDismissal {
	readonly path: string
	readonly line: number
	readonly reason: string
}

export interface PrReviewTelemetryDismissal {
	readonly name: string
	readonly path: string
	readonly line: number
}

/**
 * A submission as a stored report.
 *
 * A finding without a path or a positive line is dropped rather than invented, and so is an
 * observability finding without a check id from the audit; the count is what the span records.
 * An unknown category reads as observability when the finding carries an audit id, correctness
 * otherwise. The verdict is `issues` exactly when a warn or critical finding is retained;
 * otherwise the model's `not_applicable` survives and anything else reads as `clean`.
 */
export const normalizePrReviewSubmission = (submission: PrReviewSubmission): NormalizedPrReviewSubmission => {
	const filled = Arr.filter(Struct.keys(submission), (key) => submission[key] !== undefined)
	const rawFindings = listOf(submission.findings, decodeFindings)
	const findings: Array<PrReviewFinding> = []
	for (const raw of rawFindings) {
		const finding = normalizePrReviewFinding(raw)
		if (finding === undefined) continue
		findings.push(finding)
		if (findings.length >= MAX_FINDINGS) break
	}
	const coverage: Array<PrReviewCoverageUnit> = []
	for (const raw of listOf(submission.coverage, decodeCoverage)) {
		const unit = trimmed(raw.unit)
		if (!unit) continue
		coverage.push(
			new PrReviewCoverageUnit({
				unit: clip(unit, 200),
				kind: clip(trimmed(raw.kind) || "other", 60),
				instrumented: toBoolean(raw.instrumented),
				evidence: clip(trimmed(raw.evidence) || ""),
			}),
		)
		if (coverage.length >= MAX_COVERAGE) break
	}
	// A retained warn or critical finding is an issue whatever the model called the verdict; the
	// check run's conclusion and its inline comments must never disagree. The reverse holds too.
	const hasIssues = Arr.some(findings, (finding) => finding.severity !== "info")
	const submittedVerdict = isVerdict(submission.verdict) ? submission.verdict : undefined
	const verdict: PrReviewVerdict = hasIssues
		? "issues"
		: submittedVerdict === undefined || submittedVerdict === "issues"
			? "clean"
			: submittedVerdict
	const keyChanges = bulletsOf(submission.keyChanges, MAX_KEY_CHANGES)
	const checked = bulletsOf(submission.checked, MAX_CHECKED)
	const beforeMerge = Arr.map(
		bulletsOf(submission.beforeMerge, MAX_BEFORE_MERGE),
		(title) => new PrReviewMergeStep({ kind: "manual", title, source: "reviewer" }),
	)
	const tests =
		typeof submission.tests === "string" ? Str.toLowerCase(Str.trim(submission.tests)) : undefined
	const risk = typeof submission.risk === "string" ? Str.toLowerCase(Str.trim(submission.risk)) : undefined
	const rawConfidence = toNumber(submission.confidence)
	const confidence =
		rawConfidence === undefined
			? undefined
			: Math.min(PR_REVIEW_CONFIDENCE_MAX, Math.max(1, Math.round(rawConfidence)))
	const confidenceReason = trimmed(submission.confidenceReason)
	const telemetryDismissals = Arr.flatMap(
		listOf(submission.telemetryDismissals, decodeDismissals),
		(raw) => {
			const name = trimmed(raw.name)
			const path = trimmedPath(raw.path)
			const line = toNumber(raw.line)
			return name && path && line !== undefined && line >= 1
				? [{ name, path, line: Math.round(line) }]
				: []
		},
	)
	return {
		report: new PrReviewReport({
			verdict,
			summary: clip(trimmed(submission.summary) || "", MAX_SUMMARY),
			...(keyChanges.length > 0 ? { keyChanges } : undefined),
			...(checked.length > 0 ? { checked } : undefined),
			...(beforeMerge.length > 0 ? { beforeMerge } : undefined),
			...(isTestSignal(tests) ? { tests } : undefined),
			...(isRisk(risk) ? { risk } : undefined),
			...(confidence === undefined ? undefined : { confidence }),
			...(confidenceReason ? { confidenceReason: clip(confidenceReason, MAX_BULLET) } : undefined),
			coverage,
			findings,
		}),
		filled,
		droppedFindings: rawFindings.length - findings.length,
		resolved: [
			...new Set(
				Arr.filter(
					Arr.map(listOf(submission.resolved, decodeHandles), (handle) =>
						Str.toUpperCase(Str.trim(handle)),
					),
					(handle) => /^F\d{1,4}$/.test(handle),
				),
			),
		].slice(0, MAX_FINDINGS),
		// Bounded and deduplicated: each one costs a file read at the head before it is accepted.
		telemetryDismissals: Arr.dedupeWith(
			telemetryDismissals,
			(item, other) => other.name === item.name && other.path === item.path && other.line === item.line,
		).slice(0, MAX_DISMISSALS),
		childDismissals: Arr.flatMap(listOf(submission.childDismissals, decodeChildDismissals), (raw) => {
			const path = trimmedPath(raw.path)
			const line = toNumber(raw.line)
			const reason = trimmed(raw.reason)
			return path && reason && line !== undefined && line >= 1
				? [{ path, line: Math.round(line), reason: clip(reason, MAX_BULLET) }]
				: []
		}).slice(0, MAX_FINDINGS),
	}
}

/** What each finding costs the score, by severity. Stated in the PR comment's footer. */
export const PR_REVIEW_SCORE_PENALTY = { critical: 25, warn: 10, info: 2 } as const

export type PrReviewGrade = "excellent" | "good" | "needs work" | "poor"

/**
 * The review's score out of 100, computed from the findings rather than asked of the model.
 *
 * A model-given number drifts run to run and cannot be explained to the author; this one is 100
 * minus a fixed penalty per finding, so two reviews of the same gaps score the same and the comment
 * can say exactly why.
 */
export const scorePrReview = (
	report: PrReviewReport,
	/** Findings from earlier reviews still open at this head: they count as much as new ones. */
	carriedOpen: ReadonlyArray<{ readonly severity: PrReviewSeverity }> = [],
): { readonly score: number; readonly grade: PrReviewGrade } => {
	const all = [...report.findings, ...carriedOpen]
	const penalty = Arr.reduce(all, 0, (sum, finding) => sum + PR_REVIEW_SCORE_PENALTY[finding.severity])
	const score = Math.max(0, 100 - penalty)
	// A real issue is never "excellent", whatever the arithmetic says: the headline must agree
	// with the verdict beside it.
	const hasIssues = Arr.some(all, (finding) => finding.severity !== "info")
	const grade: PrReviewGrade =
		score >= 90 && !hasIssues ? "excellent" : score >= 75 ? "good" : score >= 50 ? "needs work" : "poor"
	return { score, grade }
}

/** The top of the confidence scale. Reports stored before 2026-10-07 were on 1 to 5 and migrated. */
export const PR_REVIEW_CONFIDENCE_MAX = 10

/** What each confidence level tells the author: two levels per band. */
export const PR_REVIEW_CONFIDENCE_LABEL = {
	10: "safe to merge",
	9: "safe to merge",
	8: "likely safe to merge",
	7: "likely safe to merge",
	6: "needs attention",
	5: "needs attention",
	4: "risky as written",
	3: "risky as written",
	2: "do not merge",
	1: "do not merge",
} as const satisfies Record<number, string>

export type PrReviewConfidence = keyof typeof PR_REVIEW_CONFIDENCE_LABEL

/** The band a level reads as: green from 7, amber at 5 and 6, red below. */
export const prReviewConfidenceTone = (confidence: number): "safe" | "attention" | "risky" =>
	confidence >= 7 ? "safe" : confidence >= 5 ? "attention" : "risky"

export interface PrReviewConfidenceResult {
	readonly confidence: PrReviewConfidence
	/** One sentence on what decides the number: the reviewer's, or why a finding held it down. */
	readonly reason: string | undefined
	/** What went into the number, each with the points it took off: `1 warning −1`, `risk medium`. */
	readonly factors: ReadonlyArray<string>
	/** A finding or an early end held the number below what the other signals gave. */
	readonly capped: boolean
	/** What held it down, when something did. */
	readonly cappedBy?: "critical" | "warn" | "partial" | "unread" | "history"
}

/** Unread reviewed files at which a review reads as "needs attention"; fewer hold it at 8. */
export const PR_REVIEW_UNREAD_CAP_FILES = 3

/**
 * What each signal takes off a 10, in whole points. A note costs nothing and medium risk costs
 * nothing: nearly every change is medium, so charging it only made 10 unreachable. High risk costs
 * its point only beside another deduction, so a clean, tested change in a risky area can read 10.
 */
export const PR_REVIEW_CONFIDENCE_DEDUCTION = {
	critical: 3,
	warn: 1,
	tests: { covered: 0, not_needed: 0, partial: 1, missing: 2 },
	risk: { low: 0, medium: 0, high: 1 },
	unobservable: 1,
} as const

/** The lowest a review reads without a critical, a security warning, an early end or unread areas. */
export const PR_REVIEW_CONFIDENCE_FLOOR = 5

const CONFIDENCE_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const satisfies ReadonlyArray<PrReviewConfidence>

const toConfidence = (value: number): PrReviewConfidence =>
	Arr.filter(CONFIDENCE_LEVELS, (level) => level <= value).at(-1) ?? 1

const findingPhrase = (n: number, label: string) => `${n} ${label}${n === 1 ? "" : "s"}`

/** A factor as the comment prints it: the points it took off, when it took any. */
const factor = (label: string, points: number) => (points > 0 ? `${label} −${points}` : label)

/**
 * Categories whose warning is a defect in what the change does, not in how it is tested or seen.
 * An open one reads "needs attention": "likely safe to merge" beside a known bug is not true.
 */
export const PR_REVIEW_DEFECT_CATEGORIES: ReadonlySet<string> = new Set([
	"correctness",
	"security",
	"performance",
])

/** A warning or critical in a defect category: one that holds a review at "needs attention". */
export const isPrReviewDefect = (finding: {
	readonly severity: PrReviewSeverity
	readonly category?: string
}) =>
	finding.severity !== "info" &&
	finding.category !== undefined &&
	PR_REVIEW_DEFECT_CATEGORIES.has(finding.category)

/**
 * A finding in a defect category, notes included: what an earlier review of the same pull request
 * counts toward its history once fixed. A bug filed as a note is still a bug the pass found, and on
 * the review corpus counting them made a 9 or 10 rarer before a review that found another.
 */
export const isPrReviewDefectHistory = (finding: { readonly category?: string }) =>
	finding.category !== undefined && PR_REVIEW_DEFECT_CATEGORIES.has(finding.category)

/**
 * The review's confidence that the change is safe to merge, 1 to 10, computed from the report alone
 * so the same findings and signals always give the same number, and the comment can show the sum.
 *
 * It starts at 10 and takes whole points off per critical and warning, for untested behavior, a
 * high-risk area (only beside another deduction) and new work that cannot be observed. Caps hold it down: a critical at 4 (2 with
 * more than one), a security warning at 4, a correctness or performance warning at 6, any other
 * warning at 8, a review that ended early at 6, reviewed files left unread at 8 (6 from three
 * files), and defects fixed since the last pass that read the whole diff at 8: a re-review reads
 * only what changed, and after a fix the next pass found another defect about a quarter of the time.
 * The pass after a fix is due the whole diff, so a clean one lifts this cap.
 * Without a critical, a security warning, an early end or three unread files it never reads under
 * 5. The reviewer's own number is not an input: a concern that should move it is a finding.
 * `undefined` for a pull request with nothing to review.
 */
export const confidencePrReview = (
	report: PrReviewReport,
	carriedOpen: ReadonlyArray<{ readonly severity: PrReviewSeverity; readonly category?: string }> = [],
	partial = false,
	/** Defects ({@link isPrReviewDefectHistory}) fixed since the last pass that read the whole diff. */
	uncheckedFixes = 0,
): PrReviewConfidenceResult | undefined => {
	if (report.verdict === "not_applicable" && report.findings.length === 0 && carriedOpen.length === 0) {
		return undefined
	}
	const all = [...report.findings, ...carriedOpen]
	const count = (severity: PrReviewSeverity) =>
		Arr.filter(all, (finding) => finding.severity === severity).length
	const criticals = count("critical")
	const warns = count("warn")
	const notes = count("info")
	const securityWarn = Arr.some(
		all,
		(finding) => finding.severity === "warn" && finding.category === "security",
	)
	const defectWarn = Arr.findFirst(
		all,
		(finding) =>
			finding.severity === "warn" && finding.category !== "security" && isPrReviewDefect(finding),
	)
	const unobservable = Arr.filter(report.coverage, (unit) => !unit.instrumented).length
	const unread = report.unreviewed?.length ?? 0
	const D = PR_REVIEW_CONFIDENCE_DEDUCTION
	// A high-risk area costs a point only beside another signal: a clean, tested change there is a 10.
	const otherPoints =
		criticals * D.critical +
		warns * D.warn +
		(report.tests === undefined ? 0 : D.tests[report.tests]) +
		(unobservable > 0 ? D.unobservable : 0)
	const riskPoints = report.risk === undefined || otherPoints === 0 ? 0 : D.risk[report.risk]

	const deductions: ReadonlyArray<readonly [label: string, points: number]> = [
		...(criticals > 0 ? [[findingPhrase(criticals, "critical"), criticals * D.critical] as const] : []),
		...(warns > 0 ? [[findingPhrase(warns, "warning"), warns * D.warn] as const] : []),
		...(notes > 0 ? [[findingPhrase(notes, "note"), 0] as const] : []),
		...(all.length === 0 ? [["no findings", 0] as const] : []),
		...(report.tests === undefined
			? []
			: [[`tests ${Str.replace("_", " ")(report.tests)}`, D.tests[report.tests]] as const]),
		...(report.risk === undefined ? [] : [[`risk ${report.risk}`, riskPoints] as const]),
		...(report.coverage.length > 0
			? [
					[
						`${report.coverage.length - unobservable}/${report.coverage.length} new units observable`,
						unobservable > 0 ? D.unobservable : 0,
					] as const,
				]
			: []),
	]
	const factors = [
		...Arr.map(deductions, ([label, points]) => factor(label, points)),
		...(unread > 0 ? [`${unread} ${unread === 1 ? "file" : "files"} not read`] : []),
		...(uncheckedFixes > 0
			? [
					`${uncheckedFixes} ${uncheckedFixes === 1 ? "fix" : "fixes"} not yet re-checked against the whole diff`,
				]
			: []),
	]
	const total = Arr.reduce(deductions, 0, (sum, [, points]) => sum + points)

	// Every cap that applies; the tightest is what the comment says held it down. A danger cap
	// lifts the floor, so the number can read red.
	const caps: ReadonlyArray<{
		readonly at: number
		readonly by: NonNullable<PrReviewConfidenceResult["cappedBy"]>
		readonly why: string
		readonly danger?: true
	}> = [
		...(criticals > 1
			? [
					{
						at: 2,
						by: "critical" as const,
						why: `${criticals} critical findings are open`,
						danger: true as const,
					},
				]
			: []),
		...(criticals === 1
			? [{ at: 4, by: "critical" as const, why: "a critical finding is open", danger: true as const }]
			: []),
		...(securityWarn
			? [{ at: 4, by: "warn" as const, why: "a security warning is open", danger: true as const }]
			: []),
		...(Option.isSome(defectWarn)
			? [{ at: 6, by: "warn" as const, why: `a ${defectWarn.value.category} warning is open` }]
			: []),
		...(partial
			? [{ at: 6, by: "partial" as const, why: "the review ended early", danger: true as const }]
			: []),
		...(unread > 0
			? [
					{
						at: unread >= PR_REVIEW_UNREAD_CAP_FILES ? 6 : 8,
						by: "unread" as const,
						why: `${unread} reviewed ${unread === 1 ? "file was" : "files were"} not read`,
						...(unread >= PR_REVIEW_UNREAD_CAP_FILES ? { danger: true as const } : undefined),
					},
				]
			: []),
		...(warns > 0 ? [{ at: 8, by: "warn" as const, why: "a warning is open" }] : []),
		...(uncheckedFixes > 0
			? [
					{
						at: 8,
						by: "history" as const,
						why: `${uncheckedFixes === 1 ? "a fix has" : `${uncheckedFixes} fixes have`} not been re-checked against the whole diff yet`,
					},
				]
			: []),
	]
	const binding = Arr.reduce<(typeof caps)[number], (typeof caps)[number] | undefined>(
		caps,
		undefined,
		(tightest, cap) => (tightest === undefined || cap.at < tightest.at ? cap : tightest),
	)
	const cap = binding?.at ?? PR_REVIEW_CONFIDENCE_MAX
	// Ordinary warnings and soft signals say "needs attention" at worst; red is for the capped dangers.
	const floor = Arr.some(caps, (item) => item.danger === true) ? 1 : PR_REVIEW_CONFIDENCE_FLOOR
	const computed = Math.max(floor, PR_REVIEW_CONFIDENCE_MAX - total)
	const confidence = toConfidence(Math.min(cap, computed))
	if (binding !== undefined && computed > cap) {
		return {
			confidence,
			reason: `Held at ${cap} because ${binding.why}.`,
			factors,
			capped: true,
			cappedBy: binding.by,
		}
	}
	// The floor is shown like a cap, so the footer's points always add up to the number.
	if (floor > 1 && PR_REVIEW_CONFIDENCE_MAX - total < floor) {
		return {
			confidence,
			reason: `Kept at ${floor}: ordinary warnings and soft signals never read below ${floor}.`,
			factors: [...factors, `floor ${floor}`],
			capped: false,
		}
	}
	return { confidence, reason: report.confidenceReason, factors, capped: false }
}
/** How copy addresses the reviewer when the install has no App slug configured. */
export const DEFAULT_REVIEWER_MENTION = "@maple"

/**
 * The reviewer's handle as people should type it: the App's own login, which GitHub autocompletes,
 * so each install names its own App rather than someone else's account.
 */
export const reviewerMention = (appSlug: string | undefined): string =>
	appSlug === undefined || Str.trim(appSlug) === "" ? DEFAULT_REVIEWER_MENTION : `@${Str.trim(appSlug)}`

const escapeRegExp = (value: string) => Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")(value)

/**
 * How a comment addresses the reviewer: `@maple`, the hosted App's login, or this install's own
 * (`mention`). Not `@maple-dev` or `@maplefoo`, and not inside an email address or a path.
 */
const mentionPattern = (mention: string | undefined): RegExp => {
	const handles = ["maple", "maplelabsapp"]
	const own = mention === undefined ? undefined : Str.replace(/^@/, "")(mention)
	if (own !== undefined && own !== "" && !handles.includes(Str.toLowerCase(own)))
		handles.push(escapeRegExp(own))
	return new RegExp(`(^|[^\\w@./-])@(?:${Arr.join(handles, "|")})(?![\\w-])`, "i")
}

/** The comment without quoted lines or fenced code: a quote-reply of `@maple fix` is not a new request. */
const addressedText = (body: string): string =>
	Arr.join(
		Arr.filter(Str.split("\n")(Str.replace(/```[\s\S]*?```/g, "")(body)), (line) => !/^\s*>/.test(line)),
		"\n",
	)

/** Whether a comment mentions the reviewer at all, outside quotes and code. */
export const mentionsReviewer = (body: string, mention?: string): boolean =>
	mentionPattern(mention).test(addressedText(body))

/**
 * The command a mention carries: the first word after it, `review` or `fix`, else a question.
 * Read outside quotes and code; `text` is the whole comment, quotes included, for the reply agent.
 */
export const parseReplyCommand = (
	body: string,
	mention?: string,
): { readonly command: PrReviewReplyCommand; readonly text: string } => {
	const cleaned = addressedText(body)
	const match = mentionPattern(mention).exec(cleaned)
	const word =
		match === null
			? undefined
			: /^\s*([a-z]+)\b/i.exec(Str.slice(match.index + match[0].length)(cleaned))?.[1]
	const lowerWord = word === undefined ? undefined : Str.toLowerCase(word)
	const command: PrReviewReplyCommand =
		lowerWord === "review" ? "review" : lowerWord === "fix" ? "fix" : "ask"
	return { command, text: Str.trim(body) }
}
