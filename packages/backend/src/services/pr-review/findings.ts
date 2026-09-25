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
import type { PullRequestDelta } from "@maple/backend/services/integrations/vcs/VcsProviderClient"

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
}

/** Lines a finding may drift between pushes and still be a restatement of the same issue. */
const SAME_ISSUE_LINES = 3

/** Share of title words two findings must have in common to read as one issue restated. */
const SAME_TITLE_OVERLAP = 0.6

/**
 * A reply that tells the reviewer to drop a finding. A question ("is this intended?") or a
 * negation ("this is not by design") asks for an answer, so it never dismisses.
 */
const DISMISSAL =
	/(?<!\bnot\s)\b(won'?t fix|wontfix|not an issue|false positive|by design|as intended|intended behaviou?r|ignore this)\b/i
const dismisses = (body: string) => !body.includes("?") && DISMISSAL.test(body)

/**
 * Open findings a person has dismissed since the last review: their thread was resolved while the
 * finding was still open (the reviewer resolves only what it marked fixed), or someone replied
 * with a dismissal. Replies from the bot that posted the finding do not count.
 */
export const dismissedFindings = (
	open: ReadonlyArray<TrackedFinding>,
	threads: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<TrackedFinding> => {
	const byComment = new Map<string, PullRequestReviewThread>()
	for (const thread of threads) {
		const first = thread.comments[0]?.commentId
		if (first !== null && first !== undefined) byComment.set(first, thread)
	}
	return open.filter((finding) => {
		if (finding.commentId === null) return false
		const thread = byComment.get(finding.commentId)
		if (thread === undefined) return false
		const poster = thread.comments[0]?.author
		return (
			thread.isResolved ||
			thread.comments.slice(1).some((reply) => reply.author !== poster && dismisses(reply.body))
		)
	})
}

/** The thread a finding's inline comment opened, to resolve once a head fixes it. */
export const threadForFinding = (
	finding: TrackedFinding,
	threads: ReadonlyArray<PullRequestReviewThread>,
): PullRequestReviewThread | undefined =>
	finding.commentId === null
		? undefined
		: threads.find((thread) => thread.comments[0]?.commentId === finding.commentId)

const titleWords = (title: string): ReadonlySet<string> =>
	new Set(
		title
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((word) => word.length > 2),
	)

/** Jaccard overlap of the two titles' words, so a reworded title still matches and a new bug does not. */
const similarTitles = (a: string, b: string) => {
	const left = titleWords(a)
	const right = titleWords(b)
	if (left.size === 0 || right.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
	const shared = [...left].filter((word) => right.has(word)).length
	return shared / (left.size + right.size - shared) >= SAME_TITLE_OVERLAP
}

/**
 * Whether a new finding is a near-exact restatement of one already tracked: same file, lens and
 * nearly the same line, and a title saying the same thing. Anything looser is left to the reviewer,
 * which judges each earlier finding at the new head: a different bug next to an old one is new.
 */
const restates = (
	finding: PrReviewFinding,
	tracked: Pick<TrackedFinding, "path" | "category" | "line" | "title">,
) =>
	finding.path === tracked.path &&
	finding.category === tracked.category &&
	Math.abs(finding.line - tracked.line) <= SAME_ISSUE_LINES &&
	similarTitles(finding.title, tracked.title)

/**
 * New findings minus near-exact restatements of a finding still open or already dismissed, a
 * backstop so a push never posts the same comment twice and a dismissed finding stays quiet.
 */
export const withoutRepeats = (
	findings: ReadonlyArray<PrReviewFinding>,
	tracked: ReadonlyArray<TrackedFinding>,
): { readonly fresh: ReadonlyArray<PrReviewFinding>; readonly repeated: number } => {
	const blocking = tracked.filter((finding) => finding.status !== "resolved")
	const fresh = findings.filter((finding) => !blocking.some((known) => restates(finding, known)))
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
	...submitted.filter((finding) => !saved.some((known) => restates(finding, known))),
]

/** `F1`, `F2`, ... continuing after every handle this pull request has used. */
export const nextHandles = (used: ReadonlyArray<string>, count: number): ReadonlyArray<string> => {
	const highest = used.reduce((max, handle) => {
		const n = Number(/^F(\d+)$/.exec(handle)?.[1] ?? 0)
		return n > max ? n : max
	}, 0)
	return Array.from({ length: count }, (_, i) => `F${highest + i + 1}`)
}

/** The handles a submission marked fixed, limited to findings that are actually open. */
export const resolvedByHandle = (
	handles: ReadonlyArray<string>,
	open: ReadonlyArray<TrackedFinding>,
): ReadonlyArray<TrackedFinding> => {
	const wanted = new Set(handles.map((handle) => handle.trim().toUpperCase()))
	return open.filter((finding) => wanted.has(finding.handle))
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
			: `${CHANGED_SINCE}${paths.slice(0, MAX_LISTED_CHANGES).join(", ")}${paths.length > MAX_LISTED_CHANGES ? `, and ${paths.length - MAX_LISTED_CHANGES} more` : ""}.`
	return changes.rewritten ? [REWRITTEN, scope] : [scope]
}

/** The kickoff section for a later push: what changed since, and what is still open. */
export const renderFollowUp = (input: {
	readonly previousSha: string
	readonly changes: PullRequestDelta | undefined
	readonly open: ReadonlyArray<TrackedFinding>
}): ReadonlyArray<string> => {
	const lines = [
		`This pull request was reviewed before, at ${input.previousSha.slice(0, 7)}.`,
		...renderChanges(input.changes),
	]
	if (input.open.length === 0) {
		lines.push("No finding from earlier reviews is still open.")
		return lines
	}
	lines.push(
		"Findings from earlier reviews that are still open. Judge each one at this head: read the code it describes, following it if it moved, and decide whether the defect is gone. Lines being modified is not enough; list a handle in `resolved` only when the code you read no longer has the problem, and leave it open when unsure.",
		"Never file a new finding that restates one of these, even where its code moved to other lines. A different defect near one of them is a new finding; file it.",
		...input.open.map(
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
	for (const line of kickoff.split("\n")) {
		if (line === NOTHING_CHANGED) return []
		if (line.startsWith(CHANGED_SINCE)) {
			return line
				.slice(CHANGED_SINCE.length)
				.replace(/(, and \d+ more)?\.$/, "")
				.split(", ")
				.filter((path) => path !== "")
		}
	}
	return undefined
}

const IGNORED_PATHS = "Never review these paths: "

/** The kickoff line naming the repository's ignored paths; {@link ignoredPathsInKickoff} reads it back. */
export const renderIgnoredPaths = (patterns: ReadonlyArray<string>): string =>
	`${IGNORED_PATHS}${patterns.join(", ")}.`

/** The ignore patterns a kickoff states, so the coverage gate never asks for a file it excludes. */
export const ignoredPathsInKickoff = (kickoff: string): ReadonlyArray<string> => {
	const line = kickoff.split("\n").find((candidate) => candidate.startsWith(IGNORED_PATHS))
	if (line === undefined) return []
	return line
		.slice(IGNORED_PATHS.length)
		.replace(/\.$/, "")
		.split(", ")
		.filter((pattern) => pattern.trim() !== "")
}

const globToRegExp = (pattern: string): RegExp => {
	const escaped = pattern
		.trim()
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\/?/g, "\uE000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\uE000/g, ".*")
	return new RegExp(`^${escaped}`)
}

/**
 * Whether a repository's settings exclude a path from review. A pattern is a glob anchored at the
 * repository root (`**` crosses directories), a directory prefix (`generated/`), or a suffix
 * (`*.pb.go` matches in any directory).
 */
export const pathIgnored = (path: string, patterns: ReadonlyArray<string> | undefined): boolean =>
	(patterns ?? []).some((raw) => {
		const pattern = raw.trim()
		if (pattern === "") return false
		if (pattern.startsWith("*.") && !pattern.includes("/")) return path.endsWith(pattern.slice(1))
		return globToRegExp(pattern).test(path)
	})
