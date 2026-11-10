// Stored shapes shared by the HTTP contract (`./http/fix-verification.ts`) and the Postgres tables.

import { Schema } from "effect"

export const VerificationStatus = Schema.Literals([
	/** Window is running; nothing has been asked of an agent yet. */
	"waiting",
	/** A verification investigation is in flight. */
	"running",
	/** The fix holds. */
	"verified",
	/** The error fired from a build that postdates the merge. */
	"not_fixed",
	/** Not enough evidence either way. */
	"inconclusive",
	/** Out of attempts, or the issue moved on underneath it. */
	"abandoned",
]).annotate({
	identifier: "@maple/VerificationStatus",
	title: "Verification Status",
})
export type VerificationStatus = Schema.Schema.Type<typeof VerificationStatus>

export const VerificationVerdict = Schema.Literals(["verified", "not_fixed", "inconclusive"]).annotate({
	identifier: "@maple/VerificationVerdict",
	title: "Verification Verdict",
})
export type VerificationVerdict = Schema.Schema.Type<typeof VerificationVerdict>

export const PullRequestLinkState = Schema.Literals(["open", "merged", "closed"]).annotate({
	identifier: "@maple/PullRequestLinkState",
	title: "Pull Request Link State",
})
export type PullRequestLinkState = Schema.Schema.Type<typeof PullRequestLinkState>

/** Who attached the pull request — an agent's `propose_fix`, a person, or the webhook's body scan. */
export const PullRequestLinkSource = Schema.Literals(["agent", "user", "auto"]).annotate({
	identifier: "@maple/PullRequestLinkSource",
	title: "Pull Request Link Source",
})
export type PullRequestLinkSource = Schema.Schema.Type<typeof PullRequestLinkSource>
