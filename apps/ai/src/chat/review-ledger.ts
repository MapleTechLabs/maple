/**
 * The findings a review pass saved with `record_finding` as it established them.
 *
 * One per turn, shared by the pass and its close-out, so a finding saved before a deadline, a
 * model error or a compaction is still posted: `submit_review` adds these to its own, and when no
 * call to it lands the runner files them as a partial review itself.
 */
import { type PrReviewFinding, PR_REVIEW_MAX_FINDINGS } from "@maple/domain/http"
import { mergeSavedFindings } from "@maple/backend/services/pr-review/findings"

export type RecordOutcome = "recorded" | "repeat" | "full"

export interface ReviewLedger {
	readonly record: (finding: PrReviewFinding) => RecordOutcome
	readonly findings: () => ReadonlyArray<PrReviewFinding>
}

export const makeReviewLedger = (): ReviewLedger => {
	const saved: Array<PrReviewFinding> = []
	return {
		record: (finding) => {
			if (saved.length >= PR_REVIEW_MAX_FINDINGS) return "full"
			// A restatement of a saved finding is the model re-recording after a compaction.
			if (mergeSavedFindings(saved, [finding]).length === saved.length) return "repeat"
			saved.push(finding)
			return "recorded"
		},
		findings: () => [...saved],
	}
}
