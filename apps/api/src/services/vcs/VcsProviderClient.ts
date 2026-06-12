import type { Effect } from "effect"
import type {
	CommitUpsertInput,
	RepoUpsertInput,
	VcsInstallation,
	VcsProviderError,
	VcsProviderId,
	VcsRepositoryRef,
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

	/** All repositories visible to an installation, normalized. */
	readonly fetchRepositories: (
		installation: VcsInstallation,
	) => Effect.Effect<ReadonlyArray<RepoUpsertInput>, VcsProviderError>

	/** Commits on a repo's default branch authored since `sinceMs`, normalized. */
	readonly fetchCommits: (
		installation: VcsInstallation,
		repo: VcsRepositoryRef,
		opts: { readonly sinceMs: number },
	) => Effect.Effect<ReadonlyArray<CommitUpsertInput>, VcsProviderError>
}
