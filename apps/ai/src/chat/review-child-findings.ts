/**
 * What the `review_files` children reported, and whether the parent's review accounts for it.
 *
 * A child's warning is a peer's finding: the parent may refute it, but not drop it unsaid. The
 * parent files each one or names it in `childDismissals` with why it does not hold.
 */
import {
	normalizePrReviewFinding,
	type PrReviewChildDismissal,
	type PrReviewFinding,
	type PrReviewFindingSubmission,
} from "@maple/domain/http"

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

/** Repo-relative, so `./src/a.ts`, `/src/a.ts` and `src/a.ts` compare equal. */
const canonicalPath = (path: string) => path.trim().replace(/^(\.\/|\/)+/, "")

/** `path:line` once a list bullet and backticks are gone; a path never holds whitespace. */
const ANCHOR = /^(\S+):(\d+)$/

/** The severity the review would post: anything but a note or a critical is a warning. */
const severityOf = (raw: string): "critical" | "warn" | "info" => {
	const word = raw.toLowerCase().replace(/[^a-z]/g, "")
	return word.startsWith("crit") ? "critical" : word === "info" || word === "note" ? "info" : "warn"
}

/**
 * A child's answer as findings: one `path:line | severity | category | title | why | fix | check`
 * line each, as `PR_REVIEW_WORKER_PROMPT` asks. Lines in any other shape are skipped.
 */
export const parseChildFindings = (answer: string): ReadonlyArray<PrReviewFindingSubmission> =>
	answer.split("\n").flatMap((line) => {
		const parts = line.split("|").map((part) => part.trim())
		const anchor = ANCHOR.exec((parts[0] ?? "").replace(/^[-*]\s+/, "").replaceAll("`", ""))
		if (parts.length < 6 || anchor === null) return []
		const [, severity, category, title, why, fix, check] = parts
		return [
			{
				path: canonicalPath(anchor[1]!),
				line: Number(anchor[2]),
				severity: severityOf(severity!),
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
	typeof b.path === "string" &&
	canonicalPath(a.path) === canonicalPath(b.path) &&
	typeof b.line === "number" &&
	Math.abs(a.line - b.line) <= LINE_SLACK

/** The children's warnings and criticals the review neither files nor dismisses. */
export const unaccountedChildFindings = (
	children: ReadonlyArray<PrReviewFindingSubmission>,
	filed: ReadonlyArray<PrReviewFinding>,
	dismissed: ReadonlyArray<PrReviewChildDismissal>,
): ReadonlyArray<PrReviewFindingSubmission> => {
	// One filed finding or dismissal accounts for one child warning, so two nearby ones need two. A
	// note does not: downgrading a child's warning is a dismissal, said with its reason.
	const claimed = new Set<PrReviewFinding | PrReviewChildDismissal>()
	const accounts = [...filed.filter((finding) => finding.severity !== "info"), ...dismissed]
	return children.filter((child) => {
		if (child.severity === "info") return false
		const match = accounts.find((entry) => !claimed.has(entry) && near(entry, child))
		if (match !== undefined) claimed.add(match)
		return match === undefined
	})
}

/**
 * Child warnings as findings the review can post. An observability one without an audit id is not
 * postable as observability; it is still a defect, so it is filed as correctness.
 */
export const childFindingsToFile = (
	unaccounted: ReadonlyArray<PrReviewFindingSubmission>,
): ReadonlyArray<PrReviewFinding> =>
	unaccounted.flatMap((raw) => {
		const finding =
			normalizePrReviewFinding(raw) ??
			normalizePrReviewFinding({ ...raw, category: "correctness", checkId: null })
		return finding === undefined ? [] : [finding]
	})

/**
 * What a pass that ended without a report files as its partial: the findings it saved, then its
 * children's warnings none of those account for.
 */
export const closeOutFindings = (
	saved: ReadonlyArray<PrReviewFinding>,
	children: ReadonlyArray<PrReviewFindingSubmission>,
): ReadonlyArray<PrReviewFinding> => [
	...saved,
	...childFindingsToFile(unaccountedChildFindings(children, saved, [])),
]

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
