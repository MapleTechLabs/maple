import type { Effect, Option } from "effect"
import type {
	BranchUpsertInput,
	CommitUpsertInput,
	GitCommitSha,
	PullRequestContext,
	PullRequestFile,
	PullRequestHead,
	PullRequestReviewThread,
	PullRequestReviewPublication,
	PullRequestReviewPublished,
	PullRequestSummary,
	RepoUpsertInput,
	VcsCommitFetch,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsProviderError,
	VcsProviderId,
	VcsRateLimitedError,
	VcsRepositoryBlockedError,
	VcsRepositoryRef,
	VcsRepoUnavailableError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"

// The single typed seam between the vendor-agnostic core and a VCS provider.
//
// Everything ABOVE this port (queue, orchestrator, webhook router, repo, tables)
// is provider-neutral and never imports a provider module. Everything BELOW it
// (GithubProvider, GithubAppClient, GitHub schemas) is provider-specific and
// never imports the vcs_* tables. The registry is the only place a provider id
// is wired to an implementation.

/** What changed on a pull request since an earlier reviewed head. */
export interface PullRequestDelta {
	/** Paths whose change differs, or undefined when it cannot be told and everything needs a look. */
	readonly paths: ReadonlyArray<string> | undefined
	/** The earlier head is no longer in the branch's history: a rebase or a force-push. */
	readonly rewritten: boolean
}

export interface VcsWebhookRequest {
	readonly headers: Record<string, string | undefined>
	readonly rawBody: string
}

/** A provider-neutral code-search hit returned to the investigation layer. */
export interface VcsCodeSearchMatch {
	readonly path: string
	readonly sha: string
	readonly htmlUrl: string
	readonly snippets: ReadonlyArray<string>
}

/** A text source file fetched from a repository at an explicit ref. */
export interface VcsSourceFile {
	readonly path: string
	readonly sha: string
	readonly htmlUrl: string
	readonly size: number
	readonly content: string
}

export interface VcsProviderClient {
	readonly id: VcsProviderId

	/** Verify the webhook signature, parse the event, and map it to generic jobs. */
	readonly webhookToJobs: (
		input: VcsWebhookRequest,
	) => Effect.Effect<ReadonlyArray<VcsSyncJob>, VcsWebhookSignatureError | VcsWebhookParseError>

	/**
	 * All repositories visible to an installation, normalized. A rate limit too far
	 * out to ride inline surfaces as `VcsRateLimitedError` (the caller redelivers the
	 * whole job after the delay — repo lists are small, so refetch is cheap).
	 */
	readonly fetchRepositories: (
		installation: VcsInstallation,
	) => Effect.Effect<
		ReadonlyArray<RepoUpsertInput>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * Commits on `branch` *committed* in `(sinceMs, untilMs]`, normalized. `branch`
	 * is always explicit — no implicit default-branch fallback. `untilMs` resumes a
	 * rate-limited backfill from a watermark; omit it for a fresh walk from the tip.
	 *
	 * Being cut short is NOT an error: on a rate limit, OR after a bounded number of
	 * pages (so one invocation's wall-clock stays under the queue limit), the provider
	 * returns what it fetched plus `VcsCommitFetch.next` (resume cursor + delay +
	 * reason). Failures: `VcsInstallationGoneError` (disconnect),
	 * `VcsRepoUnavailableError` (repo-scoped), `VcsProviderError` (transient).
	 *
	 * ORDERING CONTRACT (load-bearing — read before implementing a new provider):
	 * when the walk is cut short, the returned commits MUST be the descending-
	 * committer-date *prefix* of the requested `(sinceMs, untilMs]` window — i.e. the
	 * provider must walk the window newest-first, and a truncated page must contain
	 * the newest commits in the window, contiguously, with no gap. The resume
	 * watermark is `min(committedAt)` of the page, so the caller assumes everything
	 * from that watermark up to `untilMs` is fully fetched and resumes *below* it.
	 * A provider that truncates a page out of committer-date order (oldest-first or
	 * arbitrary) would push the watermark down past commits it never returned, and
	 * those commits are then silently skipped forever — a coverage gap, not a crash.
	 * (An *untruncated* page — `next` absent — may be in any order; the requirement
	 * only bites on truncation.) GitHub satisfies this because its commits listing is
	 * newest-first; any new provider must guarantee the same.
	 */
	readonly fetchCommits: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		opts: { readonly sinceMs: number; readonly untilMs?: number; readonly branch: string },
	) => Effect.Effect<
		VcsCommitFetch,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRepositoryBlockedError
	>

	/**
	 * All branch names of a repo (never the commits on them), normalized. `truncated`
	 * is true when the provider's listing hit its page cap — the caller then skips
	 * delete-reconciliation (absence isn't authoritative). A rate limit too far out
	 * surfaces as `VcsRateLimitedError` (the caller redelivers; branch lists are small).
	 */
	readonly fetchBranches: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
	) => Effect.Effect<
		{ readonly branches: ReadonlyArray<BranchUpsertInput>; readonly truncated: boolean },
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * Resolve a single commit by SHA within one repo, normalized. `Option.none`
	 * means "not found in this repo" (404 — expected, not a failure); errors
	 * signal genuine provider/installation failures so callers can distinguish
	 * "keep looking" from "the provider is down".
	 */
	readonly fetchCommit: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		sha: GitCommitSha,
	) => Effect.Effect<
		Option.Option<CommitUpsertInput>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRepositoryBlockedError
	>

	/**
	 * The repository's most recently updated pull requests, newest first,
	 * normalized. Bounded to `limit` and deliberately NOT paginated: this feeds a
	 * picker, and the PR that fixes a live issue is recent by construction.
	 */
	readonly fetchPullRequests: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		opts: { readonly limit: number },
	) => Effect.Effect<
		ReadonlyArray<PullRequestSummary>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * One pull request by number, normalized. `Option.none` means "no such PR in
	 * this repo" (404 — expected, not a failure), matching `fetchCommit`.
	 */
	readonly fetchPullRequest: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		number: number,
	) => Effect.Effect<
		Option.Option<PullRequestSummary>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Every file of one pull request's diff, with the provider's unified patch where it gives one. */
	readonly fetchPullRequestFiles: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		number: number,
	) => Effect.Effect<
		ReadonlyArray<PullRequestFile>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Every review thread on a pull request, to follow the reviewer's own findings. */
	readonly fetchReviewThreads: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		number: number,
	) => Effect.Effect<
		ReadonlyArray<PullRequestReviewThread>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Reply on a finding's thread, then resolve it: a later head fixed it. */
	readonly resolveReviewThread: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly number: number
			readonly threadId: string
			readonly commentId: string
			readonly reply: string
		},
	) => Effect.Effect<
		void,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * What a pull request changed between an earlier head and this one. Safe across a rebase or
	 * force-push: when the earlier head is no longer an ancestor, each head's diff against the base
	 * is compared file by file, so the base branch's own changes are never reported.
	 */
	readonly fetchChangesSince: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly previousHead: string
			readonly head: string
			/** The pull request's current base; without it a rewritten history cannot be compared. */
			readonly base: string | undefined
		},
	) => Effect.Effect<
		PullRequestDelta,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** A pull request's head and base, read fresh: a comment event does not carry them. */
	readonly fetchPullRequestHead: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		number: number,
	) => Effect.Effect<
		PullRequestHead,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Post the reviewer's answer: in the conversation, or under a review thread's first comment. */
	readonly postPullRequestReply: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: { readonly number: number; readonly body: string; readonly threadRootId?: string },
	) => Effect.Effect<
		{ readonly url: string },
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** A reaction on a comment, to acknowledge a mention before the answer is ready. */
	readonly reactToComment: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly surface: "conversation" | "review_thread"
			readonly commentId: string
			readonly content: "eyes" | "+1" | "confused"
		},
	) => Effect.Effect<
		void,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** A person's permission on the repository: `admin`, `maintain`, `write`, `triage`, `read`, `none`. */
	readonly fetchCommenterPermission: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		login: string,
	) => Effect.Effect<
		string,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * One commit of whole-file contents on top of `parentSha`, fast-forwarding `branch` to it. The
	 * only write that changes code. Never forced: a branch that moved fails rather than overwrites.
	 */
	readonly commitFiles: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly branch: string
			readonly parentSha: string
			readonly message: string
			readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
		},
	) => Effect.Effect<
		{ readonly sha: string; readonly htmlUrl: string | null },
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Commits, existing discussion and head checks of one pull request, for the reviewer. */
	readonly fetchPullRequestContext: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		number: number,
	) => Effect.Effect<
		PullRequestContext,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * Post one review's outcome onto the pull request: a check run on the head
	 * commit, and a comment-only review when there is anything to say inline.
	 * The only write on this port. Needs the App's `checks: write` and
	 * `pull_requests: write`; an installation that has not accepted them fails
	 * repository-scoped, which the review records rather than retries.
	 */
	readonly publishPullRequestReview: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		publication: PullRequestReviewPublication,
	) => Effect.Effect<
		PullRequestReviewPublished,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * Show the review as a check run on the head: running while its turn works, completed when it
	 * ends without a result. `publishPullRequestReview` completes the same run with the result.
	 */
	readonly writePullRequestCheck: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly name: string
			readonly headSha: string
			readonly state:
				| { readonly status: "in_progress" }
				| { readonly status: "completed"; readonly conclusion: "neutral" | "skipped" }
			readonly title: string
			readonly summary: string
		},
	) => Effect.Effect<
		{ readonly url: string | null },
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/**
	 * Write a review's summary comment, found by `marker` and edited in place, from the body
	 * already there. How a review says it has started before it has anything else to say.
	 * The read and the write are two requests, so the body function should only replace what it
	 * recognises (see `withReviewStatus`).
	 */
	readonly writePullRequestSummaryComment: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		input: {
			readonly number: number
			readonly marker: string
			/** `undefined` leaves the comment as it is. */
			readonly body: (existing: string | undefined) => string | undefined
		},
	) => Effect.Effect<
		{ readonly url: string | null },
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** Search source within one repository visible to this installation. */
	readonly searchCode: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		query: string,
		opts: { readonly path?: string; readonly limit: number },
	) => Effect.Effect<
		ReadonlyArray<VcsCodeSearchMatch>,
		| VcsProviderError
		| VcsInstallationGoneError
		| VcsRepoUnavailableError
		| VcsRepositoryBlockedError
		| VcsRateLimitedError
	>

	/** The commit a ref (branch, tag or SHA) names right now. `Option.none` is an unknown ref. */
	readonly resolveRef: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		ref: string,
	) => Effect.Effect<
		Option.Option<GitCommitSha>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRepositoryBlockedError
	>

	/**
	 * How to clone one repository: the credential-free remote, and a short-lived
	 * credential scoped to that repository alone. The two are kept apart so the
	 * token never has to travel inside a URL.
	 */
	readonly fetchCloneCredentials: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
	) => Effect.Effect<
		{ readonly remoteUrl: string; readonly token: string },
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRepositoryBlockedError
	>

	/** Fetch a UTF-8 source file. `Option.none` is an expected missing path/ref. */
	readonly fetchSourceFile: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		path: string,
		ref: string,
	) => Effect.Effect<
		Option.Option<VcsSourceFile>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRepositoryBlockedError
	>
}
