/**
 * A pull request's findings across pushes: which earlier ones are still open, which a person
 * dismissed, which a new review repeats, and the handles (`F3`) the reviewer knows them by.
 *
 * Pure, so the rules are tested without a database or a provider; `PrReviewService` does the I/O.
 */
import type {
	PrReviewCategory,
	PrReviewFinding,
	PrReviewFindingStatus,
	PrReviewSeverity,
	PullRequestReviewThread,
} from "@maple/domain/http"
import { isPrReviewDefectHistory } from "@maple/domain/http"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import type { PullRequestDelta } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { isPrivacyScanFinding } from "./telemetry/privacy"

/** Severities in order, for sorting and thresholds. */
export const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 } as const satisfies Record<
	PrReviewSeverity,
	number
>

/** A stored finding, as the review flow reads it. */
export interface TrackedFinding {
	readonly id: string
	readonly handle: string
	readonly path: string
	readonly line: number
	readonly category: PrReviewCategory
	readonly severity: PrReviewSeverity
	readonly title: string
	readonly status: PrReviewFindingStatus
	readonly commentId: string | null
	/** The head that fixed it, once resolved. */
	readonly resolvedSha?: string | null
}

/**
 * Defects fixed since the last pass that read the whole diff. A later push's pass reads only what
 * changed, so nothing has re-read the pull request around these fixes. `reviews` are the pull
 * request's completed reviews, newest first; one stored before `wholeDiff` existed counts as partial.
 */
export const uncheckedFixes = (
	reviews: ReadonlyArray<{ readonly headSha: string; readonly wholeDiff: boolean }>,
	tracked: ReadonlyArray<TrackedFinding>,
): number => {
	const sinceWhole = Option.match(
		Arr.findFirstIndex(reviews, (review) => review.wholeDiff),
		{ onNone: () => reviews, onSome: (lastWhole) => reviews.slice(0, lastWhole) },
	)
	const since = new Set(Arr.map(sinceWhole, (review) => review.headSha))
	return Arr.filter(
		tracked,
		(finding) =>
			finding.status === "resolved" &&
			isPrReviewDefectHistory(finding) &&
			finding.resolvedSha != null &&
			since.has(finding.resolvedSha),
	).length
}

/** Lines a finding may drift between pushes and still be a restatement of the same issue. */
const SAME_ISSUE_LINES = 3

/** Share of title words two findings must have in common to read as one issue restated. */
const SAME_TITLE_OVERLAP = 0.6

/**
 * A negation just before a verdict phrase, past an article or adverb: "not", "never", or a
 * contraction ("isn't", "wasn’t a", "not really").
 */
const NEGATED = String.raw`(?<!\b(?:not|never|no)\s(?:(?:a|an|the|really|actually)\s)?)(?<!n['’]t\s(?:(?:a|an|the|really|actually)\s)?)`

/**
 * A reply that tells the reviewer to drop a finding. A question ("is this intended?") or a
 * negation ("this isn't by design") asks for an answer, so it never dismisses.
 */
const DISMISSAL = new RegExp(
	String.raw`${NEGATED}\b(won['’]?t fix|wontfix|not an issue|not a (?:credential|secret|bug|problem|real issue)|false positive|by design|as intended|intended behaviou?r|intentional(?:ly)?|ignore this|no change needed|(?:keeping|leaving) (?:it |this )?as is)\b`,
	"i",
)

/** A reply saying the finding was dealt with: "Fixed in c88ba3a", "Done.", "Addressed by #12". */
const FIXED = new RegExp(
	// A leading verb must end its clause ("Done.", "Fixed, thanks") or go on to say how, so
	// "Fixed-size buffers still overflow" is not read as a fix.
	String.raw`(?:^\s*(?:done|fixed|addressed|resolved)(?:\s*(?:[.!,:;]|$)|\s+(?:in|by|with|via|now|it|this|that|here)\b)|${NEGATED}\b(?:fixed|addressed|resolved)\s+(?:in|by|with|via)\b)`,
	"i",
)

/** A promise, request or condition: "will be fixed", "please fix", "fixed in a follow-up". */
const NOT_YET =
	/\b(?:will|would|should|could|shall|going to|gonna|plan(?:ning)? to|need(?:s|ed)? to|has to|have to|later|follow[- ]?up|next (?:pr|pull request|push|commit)|todo|please|let['’]?s|if|once|when|until)\b/i

/** A reply saying the finding still stands: it takes back an earlier "fixed" or "won't fix". */
const STILL_OPEN =
	/\b(?:not (?:yet |actually |really )?(?:fixed|resolved|addressed)|(?:is|are)n['’]t (?:fixed|resolved)|still (?:broken|fails|failing|happens|reproduces|an issue|a problem|there|open)|(?:failure|bug|issue|problem) remains|reopen(?:ing|ed)?|regress(?:ed|es))\b/i

/** `open` takes back an earlier verdict in the thread: the finding stays with the reviewer. */
/** A hedged claim ("I don't think it's fixed", "not sure", "nothing was fixed"): no verdict either way. */
const HEDGED =
	/\b(?:don['’]?t think|not sure|unsure|nothing|doubt|unclear|maybe|may|might|perhaps|probably|hopefully|i think|i believe|seems)\b/i

type ReplyVerdict = "dismissed" | "resolved" | "open"

/**
 * A reply's verdict, only when it is an unambiguous statement. A completed fix outranks a dismissal
 * phrase in the same reply ("Fixed in c88ba3a, the call was intentional before"); anything future,
 * requested or conditional is left for the reviewer.
 */
const verdictOf = (body: string): ReplyVerdict | undefined => {
	// A question carries no verdict, not even a retraction ("Is this still broken?").
	if (Str.includes("?")(body)) return undefined
	if (STILL_OPEN.test(body)) return "open"
	if (NOT_YET.test(body) || HEDGED.test(body)) return undefined
	if (FIXED.test(body)) return "resolved"
	return DISMISSAL.test(body) ? "dismissed" : undefined
}

/**
 * What people did with open findings since the last review. A person's latest reply with a verdict
 * decides: a dismissal ("won't fix") dismisses, a fix ("Fixed in c88ba3a") resolves, a retraction
 * ("still broken") leaves it open whatever came before. With no verdict, a thread a
 * person resolved without a word, on a file this push left alone, is resolved too: most such
 * threads were fixed elsewhere or in a push whose review missed it (prod sample 2026-11-14: 19 of 28).
 * A resolved thread on a changed file (or unknown changes) stays open for the reviewer to judge.
 * Replies from the bot that posted the finding, or from any other automation, do not count. Resolved here carries no head: no
 * review confirmed it.
 */
export const settledFindings = (
	open: ReadonlyArray<TrackedFinding>,
	threads: ReadonlyArray<PullRequestReviewThread>,
	changedPaths: ReadonlySet<string> | undefined,
): {
	readonly dismissed: ReadonlyArray<TrackedFinding>
	readonly resolved: ReadonlyArray<TrackedFinding>
} => {
	const byComment = new Map<string, PullRequestReviewThread>()
	for (const thread of threads) {
		const first = thread.comments[0]?.commentId
		if (first !== null && first !== undefined) byComment.set(first, thread)
	}
	const dismissed: Array<TrackedFinding> = []
	const resolved: Array<TrackedFinding> = []
	for (const finding of open) {
		if (finding.commentId === null) continue
		const thread = byComment.get(finding.commentId)
		if (thread === undefined) continue
		const poster = thread.comments[0]?.author
		const verdicts = Arr.flatMap(thread.comments.slice(1), (reply) => {
			const verdict =
				reply.author === poster || reply.isBot === true ? undefined : verdictOf(reply.body)
			return verdict === undefined ? [] : [verdict]
		})
		const latest = verdicts.at(-1)
		if (latest === "open") continue
		const verdict =
			latest ??
			(thread.isResolved && changedPaths !== undefined && !changedPaths.has(finding.path)
				? "resolved"
				: undefined)
		if (verdict === "dismissed") dismissed.push(finding)
		else if (verdict === "resolved") resolved.push(finding)
	}
	return { dismissed, resolved }
}

/** The thread a finding's inline comment opened, to resolve once a head fixes it. */
export const threadForFinding = (
	finding: TrackedFinding,
	threads: ReadonlyArray<PullRequestReviewThread>,
): PullRequestReviewThread | undefined =>
	finding.commentId === null
		? undefined
		: Option.getOrUndefined(
				Arr.findFirst(threads, (thread) => thread.comments[0]?.commentId === finding.commentId),
			)

/** A finding the deterministic telemetry or privacy scans filed, not the model. */
const isScanFinding = (finding: Pick<PrReviewFinding, "checkId" | "title">) =>
	(finding.checkId !== undefined && Str.startsWith("TEL-")(finding.checkId)) ||
	isPrivacyScanFinding(finding)

const titleWords = (title: string): ReadonlySet<string> =>
	new Set(Arr.filter(Str.split(/[^a-z0-9_]+/)(Str.toLowerCase(title)), (word) => word.length > 2))

/** Jaccard overlap of the two titles' words, so a reworded title still matches and a new bug does not. */
const similarTitles = (a: string, b: string) => {
	const left = titleWords(a)
	const right = titleWords(b)
	if (left.size === 0 || right.size === 0)
		return Str.toLowerCase(Str.trim(a)) === Str.toLowerCase(Str.trim(b))
	const shared = Arr.filter([...left], (word) => right.has(word)).length
	return shared / (left.size + right.size - shared) >= SAME_TITLE_OVERLAP
}

/**
 * Whether a new finding is a near-exact restatement of one already tracked: same file, lens and
 * nearly the same line, and a title saying the same thing. Anything looser is left to the reviewer,
 * which judges each earlier finding at the new head: a different bug next to an old one is new.
 * A finding the service files itself (`TEL-*`, the privacy scan) names its subject in the title,
 * so the same title in the same file is the same issue wherever later pushes moved it.
 */
const restates = (
	finding: PrReviewFinding,
	tracked: Pick<TrackedFinding, "path" | "category" | "line" | "title">,
) =>
	finding.path === tracked.path &&
	finding.category === tracked.category &&
	((isScanFinding(finding) && finding.title === tracked.title) ||
		(Math.abs(finding.line - tracked.line) <= SAME_ISSUE_LINES &&
			similarTitles(finding.title, tracked.title)))

/**
 * New findings minus near-exact restatements of a finding still open, dismissed or closed by a
 * person, a backstop so a push never posts the same comment twice and a settled finding stays quiet.
 */
export const withoutRepeats = (
	findings: ReadonlyArray<PrReviewFinding>,
	tracked: ReadonlyArray<TrackedFinding>,
): { readonly fresh: ReadonlyArray<PrReviewFinding>; readonly repeated: number } => {
	// A fix a review confirmed may regress, so its restatement is posted; one a person closed, or a
	// deterministic scan's (which re-reads its own lines every push), stays quiet.
	const blocks = (finding: PrReviewFinding, known: TrackedFinding) =>
		known.status !== "resolved" || known.resolvedSha == null || isScanFinding(finding)
	const fresh = Arr.filter(
		findings,
		(finding) => !Arr.some(tracked, (known) => blocks(finding, known) && restates(finding, known)),
	)
	return { fresh, repeated: findings.length - fresh.length }
}

/**
 * A review's findings: the ones `record_finding` saved during the pass, then the ones its
 * `submit_review` adds, less any that restate a saved one. Saved come first and win, since the
 * prompt tells the reviewer never to submit them again.
 */
export const mergeSavedFindings = (
	saved: ReadonlyArray<PrReviewFinding>,
	submitted: ReadonlyArray<PrReviewFinding>,
): ReadonlyArray<PrReviewFinding> => [
	...saved,
	...Arr.filter(submitted, (finding) => !Arr.some(saved, (known) => restates(finding, known))),
]

/** `F1`, `F2`, ... continuing after every handle this pull request has used. */
export const nextHandles = (used: ReadonlyArray<string>, count: number): ReadonlyArray<string> => {
	const highest = Arr.reduce(used, 0, (max, handle) => {
		const n = Number(/^F(\d+)$/.exec(handle)?.[1] ?? 0)
		return n > max ? n : max
	})
	return Array.from({ length: count }, (_, i) => `F${highest + i + 1}`)
}

/** The handles a submission marked fixed, limited to findings that are actually open. */
export const resolvedByHandle = <F extends Pick<TrackedFinding, "handle">>(
	handles: ReadonlyArray<string>,
	open: ReadonlyArray<F>,
): ReadonlyArray<F> => {
	const wanted = new Set<string>(Arr.map(handles, (handle) => Str.toUpperCase(Str.trim(handle))))
	return Arr.filter(open, (finding) => wanted.has(finding.handle))
}

const NOTHING_CHANGED = "No file's change differs since then: check the open findings and submit."
const CHANGED_SINCE = "Files changed since then; review these, the rest was already reviewed: "
const MAX_LISTED_CHANGES = 60
const REWRITTEN =
	"The branch was rebased or force-pushed since then, so each file's change was compared against its own base; the base branch's own changes are not listed."

/**
 * What the kickoff says changed since the last reviewed head. The scope line keeps the exact
 * `NOTHING_CHANGED` / `CHANGED_SINCE` shape, because {@link followUpScope} parses it back.
 */
const renderChanges = (changes: PullRequestDelta | undefined): ReadonlyArray<string> => {
	if (changes === undefined || changes.paths === undefined)
		return [
			changes?.rewritten === true
				? "The branch was rebased or force-pushed since then and the change could not be compared file by file: review the whole diff."
				: "Which files changed since then could not be read: review the whole diff.",
		]
	const { paths } = changes
	const scope =
		paths.length === 0
			? NOTHING_CHANGED
			: `${CHANGED_SINCE}${Arr.join(paths.slice(0, MAX_LISTED_CHANGES), ", ")}${paths.length > MAX_LISTED_CHANGES ? `, and ${paths.length - MAX_LISTED_CHANGES} more` : ""}.`
	return changes.rewritten ? [REWRITTEN, scope] : [scope]
}

const RECHECK =
	"A defect is open, or was fixed since the last full pass: review the whole diff, so a fix is checked against the rest of the pull request."

/** Every file is due, so what changed is a starting point and never parses as a scope. */
const renderRecheck = (changes: PullRequestDelta | undefined): ReadonlyArray<string> => {
	const paths = changes?.paths ?? []
	return paths.length === 0
		? [RECHECK]
		: [
				RECHECK,
				`Start with what changed since then: ${Arr.join(paths.slice(0, MAX_LISTED_CHANGES), ", ")}${paths.length > MAX_LISTED_CHANGES ? `, and ${paths.length - MAX_LISTED_CHANGES} more` : ""}.`,
			]
}

/**
 * The kickoff section for a later push: what changed since, and what is still open. With
 * `recheck`, a defect is open or was fixed since the last whole-diff pass, so this pass is due every file.
 */
export const renderFollowUp = (input: {
	readonly previousSha: string
	readonly changes: PullRequestDelta | undefined
	readonly open: ReadonlyArray<TrackedFinding>
	readonly recheck?: boolean
}): ReadonlyArray<string> => {
	const lines = [
		`This pull request was reviewed before, at ${Str.slice(0, 7)(input.previousSha)}.`,
		...(input.recheck === true ? renderRecheck(input.changes) : renderChanges(input.changes)),
	]
	if (input.open.length === 0) {
		lines.push("No finding from earlier reviews is still open.")
		return lines
	}
	lines.push(
		"Findings from earlier reviews that are still open. Judge each one at this head: read the code it describes, following it if it moved, and decide whether the defect is gone. Lines being modified is not enough; list a handle in `resolved` only when the code you read no longer has the problem, and leave it open when unsure.",
		"Never file a new finding that restates one of these, even where its code moved to other lines. A different defect near one of them is a new finding; file it.",
		...Arr.map(
			input.open,
			(finding) =>
				`- ${finding.handle} · ${finding.path}:${finding.line} · ${finding.category} · ${finding.severity} · ${finding.title}`,
		),
	)
	return lines
}

/**
 * The files a later push's kickoff asks the reviewer to read, parsed back from
 * {@link renderFollowUp}: none when nothing changed, `undefined` when the kickoff names no scope
 * (a first review, or a push whose comparison failed) and every file is in scope.
 */
export const followUpScope = (kickoff: string): ReadonlyArray<string> | undefined => {
	for (const line of Str.split("\n")(kickoff)) {
		if (line === NOTHING_CHANGED) return []
		if (Str.startsWith(CHANGED_SINCE)(line)) {
			return Arr.filter(
				pipe(
					line,
					Str.slice(CHANGED_SINCE.length),
					Str.replace(/(, and \d+ more)?\.$/, ""),
					Str.split(", "),
				),
				(path) => path !== "",
			)
		}
	}
	return undefined
}

const IGNORED_PATHS = "Never review these paths: "

/** The kickoff line naming the repository's ignored paths; {@link ignoredPathsInKickoff} reads it back. */
export const renderIgnoredPaths = (patterns: ReadonlyArray<string>): string =>
	`${IGNORED_PATHS}${Arr.join(patterns, ", ")}.`

/** The ignore patterns a kickoff states, so the coverage gate never asks for a file it excludes. */
export const ignoredPathsInKickoff = (kickoff: string): ReadonlyArray<string> => {
	const line = Arr.findFirst(Str.split("\n")(kickoff), (candidate) =>
		Str.startsWith(IGNORED_PATHS)(candidate),
	)
	if (Option.isNone(line)) return []
	return Arr.filter(
		pipe(line.value, Str.slice(IGNORED_PATHS.length), Str.replace(/\.$/, ""), Str.split(", ")),
		(pattern) => Str.trim(pattern) !== "",
	)
}

const globToRegExp = (pattern: string): RegExp => {
	const escaped = pipe(
		Str.trim(pattern),
		Str.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
		Str.replace(/\*\*\/?/g, "\uE000"),
		Str.replace(/\*/g, "[^/]*"),
		Str.replace(/\?/g, "[^/]"),
		Str.replace(/\uE000/g, ".*"),
	)
	return new RegExp(`^${escaped}`)
}

/**
 * Whether a repository's settings exclude a path from review. A pattern is a glob anchored at the
 * repository root (`**` crosses directories), a directory prefix (`generated/`), or a suffix
 * (`*.pb.go` matches in any directory).
 */
export const pathIgnored = (path: string, patterns: ReadonlyArray<string> | undefined): boolean =>
	Arr.some(patterns ?? [], (raw) => {
		const pattern = Str.trim(raw)
		if (pattern === "") return false
		if (Str.startsWith("*.")(pattern) && !Str.includes("/")(pattern))
			return Str.endsWith(Str.slice(1)(pattern))(path)
		return globToRegExp(pattern).test(path)
	})
