/**
 * What the `review_files` children reported, and whether the parent's review accounts for it.
 *
 * A child's warning is a peer's finding: the parent may refute it, but not drop it unsaid. The
 * parent files each one or names it in `childDismissals` with why it does not hold.
 */
import type { PrReviewChildDismissal, PrReviewFinding, PrReviewFindingSubmission } from "@maple/domain/http"

export interface ChildFindings {
	/** One child's answer, as the parent received it. */
	readonly observe: (answer: string) => void
	readonly all: () => ReadonlyArray<PrReviewFindingSubmission>
}

export const makeChildFindings = (): ChildFindings => {
	const found: Array<PrReviewFindingSubmission> = []
	return {
		observe: (answer) => {
			found.push(...parseChildFindings(answer))
		},
		all: () => found,
	}
}

const ANCHOR = /^`?(.+?):(\d+)`?$/

/**
 * A child's answer as findings: one `path:line | severity | category | title | why | fix | check`
 * line each, as `PR_REVIEW_WORKER_PROMPT` asks. Lines in any other shape are skipped.
 */
export const parseChildFindings = (answer: string): ReadonlyArray<PrReviewFindingSubmission> =>
	answer.split("\n").flatMap((line) => {
		const parts = line.split("|").map((part) => part.trim())
		const anchor = ANCHOR.exec(parts[0] ?? "")
		if (parts.length < 6 || anchor === null) return []
		const [, severity, category, title, why, fix, check] = parts
		return [
			{
				path: anchor[1]!.trim(),
				line: Number(anchor[2]),
				severity: severity!.toLowerCase(),
				category: category!.toLowerCase(),
				title: title!,
				body: why!,
				...(fix ? { suggestion: fix } : undefined),
				...(check && check !== "-" ? { checkId: check } : undefined),
			},
		]
	})

/** How far apart two models may anchor the same issue. */
const LINE_SLACK = 5

const near = (a: { path: string; line: number }, b: { path?: string | null; line?: unknown }) =>
	a.path === b.path?.trim() && typeof b.line === "number" && Math.abs(a.line - b.line) <= LINE_SLACK

/** The children's warnings and criticals the review neither files nor dismisses. */
export const unaccountedChildFindings = (
	children: ReadonlyArray<PrReviewFindingSubmission>,
	filed: ReadonlyArray<PrReviewFinding>,
	dismissed: ReadonlyArray<PrReviewChildDismissal>,
): ReadonlyArray<PrReviewFindingSubmission> =>
	children.filter(
		(child) =>
			(child.severity === "warn" || child.severity === "critical") &&
			!filed.some((finding) => near(finding, child)) &&
			!dismissed.some((dismissal) => near(dismissal, child)),
	)

/** The one-time refusal `submit_review` answers with while a child's warning is unaccounted for. */
export const childFindingsRefusal = (unaccounted: ReadonlyArray<PrReviewFindingSubmission>): string =>
	[
		`Your child reviewers reported ${unaccounted.length === 1 ? "a finding" : `${unaccounted.length} findings`} this review neither files nor dismisses:`,
		...unaccounted.map(
			(finding) => `- ${finding.path}:${finding.line} (${finding.severity}) ${finding.title}`,
		),
		"File each one that holds, or list it in childDismissals with its path, line and the reason it does not hold, " +
			"then call submit_review again. Any still unaccounted for on that call is filed as the child reported it.",
	].join("\n")
