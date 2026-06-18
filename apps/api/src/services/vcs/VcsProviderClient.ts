import type { Effect, Option } from "effect"
import type {
	BranchUpsertInput,
	CommitUpsertInput,
	GitCommitSha,
	RepoUpsertInput,
	VcsCommitFetch,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsProviderError,
	VcsProviderId,
	VcsRateLimitedError,
	VcsRepositoryRef,
	VcsRepoUnavailableError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"

// ---------------------------------------------------------------------------
// The single typed seam between the vendor-agnostic core and a VCS provider.
//
// Everything ABOVE this port (queue, orchestrator, webhook router, repo, tables)
// is provider-neutral and never imports a provider module. Everything BELOW it
// (GithubProvider, GithubAppClient, GitHub schemas) is provider-specific and
// never imports the vcs_* tables. The registry is the only place a provider id
// is wired to an implementation.
// ---------------------------------------------------------------------------

export interface VcsWebhookRequest {
	readonly headers: Record<string, string | undefined>
	readonly rawBody: string
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
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError
	>

	/**
	 * Commits on `branch` *committed* in `(sinceMs, untilMs]`, normalized. `branch`
	 * is always explicit — the caller decides which ref to walk (there is no implicit
	 * default-branch fallback). `untilMs` resumes a rate-limited backfill from a
	 * watermark; omit it for a fresh walk from the tip. The `sinceMs`/`untilMs` filter
	 * is keyed on committer date; the exact basis and ordering are provider-defined
	 * and never assumed by callers.
	 *
	 * Being cut short is NOT an error here: on a rate limit, OR after a bounded
	 * number of pages (so one invocation's wall-clock stays under the queue limit),
	 * the provider returns what it fetched plus `VcsCommitFetch.next` (resume cursor
	 * + delay + reason). Failures are classified as `VcsInstallationGoneError`
	 * (disconnect), `VcsRepoUnavailableError` (repo-scoped), else `VcsProviderError`
	 * (transient / retryable).
	 */
	readonly fetchCommits: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		opts: { readonly sinceMs: number; readonly untilMs?: number; readonly branch: string },
	) => Effect.Effect<
		VcsCommitFetch,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
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
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError | VcsRateLimitedError
	>

	/**
	 * Resolve a single commit by SHA within one repo, normalized. Used by the
	 * dashboard's hover card to fetch-and-store a commit not yet synced — the SHA
	 * carries no repo association (it comes from telemetry), so the caller probes
	 * each of the org's repos until one resolves. `Option.none` means "this repo
	 * does not contain that SHA" (a 404 — expected during the probe, not a
	 * failure); errors are reserved for genuine provider/installation failures so
	 * the caller can distinguish "keep looking" from "the provider is down".
	 */
	readonly fetchCommit: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		sha: GitCommitSha,
	) => Effect.Effect<
		Option.Option<CommitUpsertInput>,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
	>
}
