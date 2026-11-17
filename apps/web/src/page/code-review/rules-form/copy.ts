// The rules form's fixed labels and hints, shared with its loading skeleton.

export const RULES_COPY = {
	instructionsHint: "Read alongside each repository's own CLAUDE.md, AGENTS.md and .maple/review.md.",
	ignoreHint: "One per line. The review never reads files that match.",
	lensesHint: "Issues are only filed under checked lenses.",
	severity: { label: "Inline comments", description: "The summary comment lists every issue either way." },
	feedback: {
		label: "Learn from feedback",
		description:
			"Skips issues like ones your team downvoted or dismissed. Security and critical issues are always posted.",
	},
	limit: {
		label: "Daily limit per repository",
		description: "Reviews a repository may start per UTC day.",
	},
	perPr: {
		label: "Reviews per pull request",
		/** Wraps the `review` command: before it, then after it. */
		description: [
			"After this many, pushes stop starting reviews. Mention the reviewer with",
			"to run one anyway.",
		],
	},
	drafts: { label: "Review drafts", description: "Draft pull requests are skipped unless this is on." },
	external: {
		label: "Review outside contributors",
		description:
			"Reviews pull requests from people without push access, forks included, on public repositories. The agent reads your telemetry and its review is public. One automatic review per pull request, three per author a day.",
	},
	blockBreaks: {
		label: "Fail the check on broken telemetry",
		description:
			"Fails the review check when a pull request removes a span, attribute or metric name that an alert or dashboard reads, and the name is not emitted anywhere else.",
	},
	postMerge: {
		label: "Check production after merge",
		description:
			"An hour after a reviewed pull request deploys, compares the operations it touched before and after, and comments on the pull request.",
	},
	autoApprove: {
		label: "Approve low-risk pull requests",
		description:
			"Approves on GitHub when a review of the whole diff rates the risk low, finds nothing to fix and scores 9 or more, and the author can push to the repository. A new push or a later review that disagrees withdraws it. Never counts as a code owner's review.",
	},
} as const
