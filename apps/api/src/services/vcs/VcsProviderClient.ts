import type { Effect } from "effect"
import type {
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
	 * Commits on a repo's default branch *committed* in `(sinceMs, untilMs]`,
	 * normalized. `untilMs` resumes a rate-limited backfill from a watermark; omit
	 * it for a fresh walk from the tip. The `sinceMs`/`untilMs` filter is keyed on
	 * committer date; the exact basis and ordering are provider-defined and never
	 * assumed by callers.
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
		opts: { readonly sinceMs: number; readonly untilMs?: number },
	) => Effect.Effect<
		VcsCommitFetch,
		VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
	>
}
