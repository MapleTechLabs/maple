/**
 * Which of a pull request's reviewed files a review pass has actually read.
 *
 * The prompt says to read every hunk; this is what checks it. One tracker per run, fed every Maple
 * tool answer the run dispatches, including the ones its `review_files` children dispatch through
 * the same handlers. `submit_review` consults it once before recording.
 */
import { followUpScope, ignoredPathsInKickoff, pathIgnored } from "@maple/backend/services/pr-review/findings"
import { pathsInDiffAnswer, reviewablePathsInListing } from "../mcp/tools/pull-request"

export interface ReviewCoverage {
	/** One successful tool answer, by tool name. */
	readonly observe: (tool: string, answer: string) => void
	/** Reviewed files with a patch whose diff no `pr_file_diff` answer has shown yet, in listing order. */
	readonly unread: () => ReadonlyArray<string>
}

/**
 * `kickoff` is the pass's first message: a later push's kickoff narrows which files are due, and a
 * path the repository's settings ignore is never due, since the kickoff tells the reviewer to skip it.
 */
export const makeReviewCoverage = (kickoff: string): ReviewCoverage => {
	const scope = followUpScope(kickoff)
	const ignored = ignoredPathsInKickoff(kickoff)
	const inScope = (path: string) =>
		(scope === undefined || scope.includes(path)) && !pathIgnored(path, ignored)
	const due = new Set<string>()
	const read = new Set<string>()
	return {
		observe: (tool, answer) => {
			if (tool === "pr_changed_files") {
				for (const path of reviewablePathsInListing(answer)) if (inScope(path)) due.add(path)
			} else if (tool === "pr_file_diff") {
				for (const path of pathsInDiffAnswer(answer)) read.add(path)
			}
		},
		unread: () => [...due].filter((path) => !read.has(path)),
	}
}

const LISTED_UNREAD = 30

/** The one-time refusal `submit_review` answers with while files are unread. */
export const unreadRefusal = (unread: ReadonlyArray<string>): string =>
	[
		`You have not read the diff of ${unread.length} reviewed ${unread.length === 1 ? "file" : "files"}: ` +
			`${unread.slice(0, LISTED_UNREAD).join(", ")}${unread.length > LISTED_UNREAD ? `, and ${unread.length - LISTED_UNREAD} more` : ""}.`,
		"Read them with pr_file_diff (several per call) or review_files, then call submit_review again. " +
			"If you left them unread on purpose, call submit_review again now and it will be recorded; say in the summary what was not read.",
	].join(" ")
