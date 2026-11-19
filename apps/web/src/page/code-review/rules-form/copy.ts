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
	mapleTools: {
		label: "Maple tools",
		description:
			"Lets the reviewer and its replies query this organization's traces, logs, metrics and errors. Off, a review reads only the diff and the code. Always off on public repositories, where reviews are public.",
		publicLock: "Public repositories never get Maple tools: their reviews are world-readable.",
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
			"Approves on GitHub when a review of a small diff rates the risk low and finds nothing to fix. The approval counts toward the reviews a branch requires, on the author's own pull request too, but never as a code owner's. Only admins can turn it on.",
	},
} as const
