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

/** Lines a finding may drift between pushes and still be the same issue. */
const SAME_ISSUE_LINES = 3

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

/** Whether a new finding restates one already tracked: same file, lens, and nearly the same line. */
const restates = (finding: PrReviewFinding, tracked: TrackedFinding) =>
	finding.path === tracked.path &&
	finding.category === tracked.category &&
	Math.abs(finding.line - tracked.line) <= SAME_ISSUE_LINES

/**
 * New findings minus those that repeat a finding still open or already dismissed, so a push never
 * posts the same comment twice and a dismissed finding stays quiet.
 */
export const withoutRepeats = (
	findings: ReadonlyArray<PrReviewFinding>,
	tracked: ReadonlyArray<TrackedFinding>,
): { readonly fresh: ReadonlyArray<PrReviewFinding>; readonly repeated: number } => {
	const blocking = tracked.filter((finding) => finding.status !== "resolved")
	const fresh = findings.filter((finding) => !blocking.some((known) => restates(finding, known)))
	return { fresh, repeated: findings.length - fresh.length }
}

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

const NOTHING_CHANGED =
	"No file changed since then (a rebase or an empty commit): check the open findings and submit."
const CHANGED_SINCE = "Files changed since then; review these, the rest was already reviewed: "
const MAX_LISTED_CHANGES = 60

/** The kickoff section for a later push: what changed since, and what is still open. */
export const renderFollowUp = (input: {
	readonly previousSha: string
	readonly changedPaths: ReadonlyArray<string> | undefined
	readonly open: ReadonlyArray<TrackedFinding>
}): ReadonlyArray<string> => {
	const lines = [`This pull request was reviewed before, at ${input.previousSha.slice(0, 7)}.`]
	if (input.changedPaths !== undefined) {
		lines.push(
			input.changedPaths.length === 0
				? NOTHING_CHANGED
				: `${CHANGED_SINCE}${input.changedPaths.slice(0, MAX_LISTED_CHANGES).join(", ")}${input.changedPaths.length > MAX_LISTED_CHANGES ? `, and ${input.changedPaths.length - MAX_LISTED_CHANGES} more` : ""}.`,
		)
	}
	if (input.open.length === 0) {
		lines.push("No finding from earlier reviews is still open.")
		return lines
	}
	lines.push(
		"Findings from earlier reviews that are still open. For each, read its lines at this head; list the handles this head fixes in `resolved`. Never file a new finding for one of these.",
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
