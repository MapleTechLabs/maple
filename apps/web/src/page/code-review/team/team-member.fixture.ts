import { CodeReviewTeamMember } from "@maple/domain/http"

/** A team member for tests: every count zero unless given. */
export const member = (login: string, counts: Partial<CodeReviewTeamMember> = {}) =>
	new CodeReviewTeamMember({
		login,
		pullRequests: 0,
		mergedPullRequests: 0,
		medianMergeSeconds: null,
		findings: 0,
		criticalFindings: 0,
		resolvedFindings: 0,
		openAtMergeFindings: 0,
		shippedClean: 0,
		shippedRegressed: 0,
		ciRuns: 0,
		firstTryRuns: 0,
		firstTryGreen: 0,
		reruns: 0,
		cancelledRuns: 0,
		runnerMs: 0,
		...counts,
	})
