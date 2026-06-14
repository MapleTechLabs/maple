import { Schema, SchemaGetter } from "effect"
import { OrgId, UserId } from "../primitives"

// ---------------------------------------------------------------------------
// Vendor-agnostic VCS integration types.
//
// Everything here is provider-neutral: rows carry a `provider` discriminator
// and GitHub-specific concepts (App auth, REST/webhook payload shapes) live in
// the GitHub layer behind the `VcsProviderClient` port. Adding another provider
// means extending `VcsProviderId` + the enum normalizations — no new tables.
// ---------------------------------------------------------------------------

// ---- Branded IDs ----------------------------------------------------------

export const VcsInstallationId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsInstallationId"),
	Schema.annotate({ identifier: "@maple/VcsInstallationId", title: "VCS Installation ID" }),
)
export type VcsInstallationId = Schema.Schema.Type<typeof VcsInstallationId>

export const VcsRepositoryId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsRepositoryId"),
	Schema.annotate({ identifier: "@maple/VcsRepositoryId", title: "VCS Repository ID" }),
)
export type VcsRepositoryId = Schema.Schema.Type<typeof VcsRepositoryId>

export const VcsCommitRowId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsCommitRowId"),
	Schema.annotate({ identifier: "@maple/VcsCommitRowId", title: "VCS Commit Row ID" }),
)
export type VcsCommitRowId = Schema.Schema.Type<typeof VcsCommitRowId>

/**
 * A full 40-char git commit SHA. Case-insensitive on input and normalized to
 * lowercase during decode, so the same commit is identified regardless of the
 * case a provider — or an OTel `deployment.commit_sha` attribute — emits it in.
 * Strict — unlike the permissive telemetry `CommitSha` brand (which must not
 * throw on arbitrary OTel data) — so the SHA-shape regex lives in exactly this
 * one declarative type. Decoding a value through it (at the webhook/REST
 * boundary and on persistence) is the only SHA validation in the codebase.
 *
 * (40 hex = git's SHA-1 object format; git's experimental SHA-256 object format
 * — 64 hex — is a known, currently-unused limitation across every git host.)
 */
const GitCommitShaBrand = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
	Schema.brand("@maple/GitCommitSha"),
)
export const GitCommitSha = Schema.String.pipe(
	// Lowercase on the way in (before the pattern check) so `aBc…` and `ABC…`
	// resolve to the same branded value, hence the same row and the same lookup.
	Schema.decodeTo(GitCommitShaBrand, {
		decode: SchemaGetter.transform((s: string) => s.toLowerCase()),
		encode: SchemaGetter.passthrough<string>(),
	}),
	Schema.annotate({ identifier: "@maple/GitCommitSha", title: "Git Commit SHA" }),
)
export type GitCommitSha = Schema.Schema.Type<typeof GitCommitSha>

// ---- Provider + normalized enums ------------------------------------------

/** The set of supported VCS providers. Extend this array to add a provider. */
export const VcsProviderId = Schema.Literals(["github"]).annotate({
	identifier: "@maple/VcsProviderId",
	title: "VCS Provider",
})
export type VcsProviderId = Schema.Schema.Type<typeof VcsProviderId>

export const VcsAccountType = Schema.Literals(["organization", "user"]).annotate({
	identifier: "@maple/VcsAccountType",
	title: "VCS Account Type",
})
export type VcsAccountType = Schema.Schema.Type<typeof VcsAccountType>

export const VcsInstallStatus = Schema.Literals(["active", "suspended", "disconnected"]).annotate({
	identifier: "@maple/VcsInstallStatus",
	title: "VCS Installation Status",
})
export type VcsInstallStatus = Schema.Schema.Type<typeof VcsInstallStatus>

export const VcsRepoSelection = Schema.Literals(["all", "selected"]).annotate({
	identifier: "@maple/VcsRepoSelection",
	title: "VCS Repository Selection",
})
export type VcsRepoSelection = Schema.Schema.Type<typeof VcsRepoSelection>

export const VcsRepoSyncStatus = Schema.Literals(["pending", "backfilling", "ready", "error"]).annotate({
	identifier: "@maple/VcsRepoSyncStatus",
	title: "VCS Repository Sync Status",
})
export type VcsRepoSyncStatus = Schema.Schema.Type<typeof VcsRepoSyncStatus>

// ---- Row → domain models (validated reads) --------------------------------

export class VcsInstallation extends Schema.Class<VcsInstallation>("VcsInstallation")({
	id: VcsInstallationId,
	orgId: OrgId,
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	accountLogin: Schema.String,
	accountType: VcsAccountType,
	externalAccountId: Schema.String,
	accountAvatarUrl: Schema.NullOr(Schema.String),
	repositorySelection: VcsRepoSelection,
	status: VcsInstallStatus,
	suspendedAt: Schema.NullOr(Schema.Number),
	installedByUserId: UserId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

/**
 * The single, vendor-agnostic answer to "should the sync engine act on this
 * installation's data?". Only `active` installations are processed — `suspended`
 * (provider temporarily disabled it) and `disconnected` (uninstalled / access
 * revoked) are both skipped. Every data-processing path gates on this so the
 * rule lives in exactly one place.
 */
export const isInstallationProcessable = (installation: VcsInstallation): boolean =>
	installation.status === "active"

export class VcsRepo extends Schema.Class<VcsRepo>("VcsRepo")({
	id: VcsRepositoryId,
	orgId: OrgId,
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	fullName: Schema.String,
	defaultBranch: Schema.String,
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	isArchived: Schema.Boolean,
	syncStatus: VcsRepoSyncStatus,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastSyncError: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class VcsCommit extends Schema.Class<VcsCommit>("VcsCommit")({
	id: VcsCommitRowId,
	orgId: OrgId,
	provider: VcsProviderId,
	externalRepoId: Schema.String,
	sha: GitCommitSha,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorEmail: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	authoredAt: Schema.NullOr(Schema.Number),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
	branch: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
}) {}

// ---- Boundary input DTOs (provider → repo / queue) ------------------------

/** Normalized repository, returned by a provider and persisted by the repo. */
export const RepoUpsertInput = Schema.Struct({
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	fullName: Schema.String,
	defaultBranch: Schema.String,
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	isArchived: Schema.Boolean,
})
export type RepoUpsertInput = Schema.Schema.Type<typeof RepoUpsertInput>

/** Normalized commit, returned by a provider (or extracted from a push). */
export const CommitUpsertInput = Schema.Struct({
	sha: Schema.String,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorEmail: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	authoredAt: Schema.NullOr(Schema.Number),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
	branch: Schema.NullOr(Schema.String),
})
export type CommitUpsertInput = Schema.Schema.Type<typeof CommitUpsertInput>

/**
 * Result of a provider commit fetch: the normalized commits, plus an optional
 * resume cursor. The branch head is deliberately NOT reported — incremental sync
 * derives its watermark from `max(committed_at)` of the persisted commits, so no
 * provider has to claim a head and no caller infers one from array position.
 *
 * `next` is present iff the walk was cut short before the requested window was
 * fully fetched, for one of two reasons:
 *  - `"rate-limited"`: the provider throttled us — resume after `retryAfterSeconds`.
 *  - `"page-budget"`: the provider voluntarily yielded after a bounded number of
 *    pages, to keep a single consumer invocation's wall-clock under the queue's
 *    limit — resume immediately (`retryAfterSeconds` is 0).
 * Either way, resume the backfill from `untilMs` (a committer-date watermark).
 * Absent ⇒ the window is complete.
 */
export interface VcsCommitFetch {
	readonly commits: ReadonlyArray<CommitUpsertInput>
	readonly next?: {
		readonly untilMs: number
		readonly retryAfterSeconds: number
		readonly reason: "rate-limited" | "page-budget"
	}
}

/** Minimal repo identity a provider needs to fetch commits. */
export const VcsRepositoryRef = Schema.Struct({
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	defaultBranch: Schema.String,
})
export type VcsRepositoryRef = Schema.Schema.Type<typeof VcsRepositoryRef>

// ---- Queue jobs (vendor-agnostic; orgId resolved by the orchestrator) ------

export const VcsInstallationSyncReason = Schema.Literals([
	"created",
	"unsuspend",
	"repositories_added",
	"repositories_removed",
	"suspend",
	"deleted",
]).annotate({ identifier: "@maple/VcsInstallationSyncReason", title: "VCS Installation Sync Reason" })
export type VcsInstallationSyncReason = Schema.Schema.Type<typeof VcsInstallationSyncReason>

// Jobs carry only `externalInstallationId` (+ provider); the sync orchestrator
// resolves `orgId` from the installation row. A webhook handler has no DB
// access and cannot know the Maple org, so it must not be carried here.
export const InstallationSyncJob = Schema.Struct({
	kind: Schema.Literal("installation-sync"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	reason: VcsInstallationSyncReason,
})
export type InstallationSyncJob = Schema.Schema.Type<typeof InstallationSyncJob>

export const BackfillRepoJob = Schema.Struct({
	kind: Schema.Literal("backfill-repo"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	owner: Schema.String,
	name: Schema.String,
	defaultBranch: Schema.String,
	sinceMs: Schema.Number,
	// Resume cursor for a continuation requeued after a rate limit: fetch commits
	// committed at-or-before `untilMs` (a committer-date watermark). Absent on a
	// fresh backfill.
	untilMs: Schema.optionalKey(Schema.Number),
	// Count of consecutive continuations that fetched zero commits (rate-limited
	// before any progress). Reset to 0 whenever a run makes progress; bounded so a
	// permanently throttled installation can't requeue forever. Absent ⇒ 0.
	staleAttempts: Schema.optionalKey(Schema.Number),
})
export type BackfillRepoJob = Schema.Schema.Type<typeof BackfillRepoJob>

// A push event's commits, applied incrementally — purely best-effort enrichment.
// A push may target any branch and its payload may be incomplete (GitHub caps
// `commits` at 2048 per delivery and sends one delivery per push, not many), so
// it is never treated as an authoritative sync: the default-branch backfill is
// the source of truth and re-fetches the full history regardless.
export const PushJob = Schema.Struct({
	kind: Schema.Literal("push"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	branch: Schema.String,
	commits: Schema.Array(CommitUpsertInput),
})
export type PushJob = Schema.Schema.Type<typeof PushJob>

export const VcsSyncJob = Schema.Union([InstallationSyncJob, BackfillRepoJob, PushJob])
export type VcsSyncJob = Schema.Schema.Type<typeof VcsSyncJob>

// ---- Tagged errors --------------------------------------------------------

export class VcsRepoPersistenceError extends Schema.TaggedErrorClass<VcsRepoPersistenceError>()(
	"@maple/http/errors/VcsRepoPersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class VcsRepoDecodeError extends Schema.TaggedErrorClass<VcsRepoDecodeError>()(
	"@maple/http/errors/VcsRepoDecodeError",
	{ message: Schema.String, table: Schema.String, column: Schema.optional(Schema.String) },
	{ httpApiStatus: 500 },
) {}

export class VcsQueueError extends Schema.TaggedErrorClass<VcsQueueError>()(
	"@maple/http/errors/VcsQueueError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class VcsProviderError extends Schema.TaggedErrorClass<VcsProviderError>()(
	"@maple/http/errors/VcsProviderError",
	{
		message: Schema.String,
		status: Schema.optional(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect),
	},
	{ httpApiStatus: 502 },
) {}

/**
 * The provider is certain the installation no longer exists / access is
 * permanently revoked at the installation level (e.g. GitHub's installation
 * token endpoint returning gone). The ONLY error the sync orchestrator treats
 * as a disconnect — raw HTTP status never drives that decision. Providers must
 * only raise this when the signal is unambiguous.
 */
export class VcsInstallationGoneError extends Schema.TaggedErrorClass<VcsInstallationGoneError>()(
	"@maple/http/errors/VcsInstallationGoneError",
	{ message: Schema.String },
	{ httpApiStatus: 410 },
) {}

/**
 * The provider is certain a specific repository is permanently inaccessible
 * (deleted / renamed / access lost). Scoped to the repo — never the installation.
 */
export class VcsRepoUnavailableError extends Schema.TaggedErrorClass<VcsRepoUnavailableError>()(
	"@maple/http/errors/VcsRepoUnavailableError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

/**
 * A provider rate limit too far out to wait through inline. `retryAfterSeconds`
 * is when the budget is available again (from `retry-after` / the rate-limit
 * reset). The sync consumer redelivers the failed job with this delay; backfill
 * instead catches it earlier and requeues from a cursor (see `VcsCommitFetch.next`).
 */
export class VcsRateLimitedError extends Schema.TaggedErrorClass<VcsRateLimitedError>()(
	"@maple/http/errors/VcsRateLimitedError",
	{ message: Schema.String, retryAfterSeconds: Schema.Number },
	{ httpApiStatus: 429 },
) {}

export class VcsWebhookSignatureError extends Schema.TaggedErrorClass<VcsWebhookSignatureError>()(
	"@maple/http/errors/VcsWebhookSignatureError",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

export class VcsWebhookParseError extends Schema.TaggedErrorClass<VcsWebhookParseError>()(
	"@maple/http/errors/VcsWebhookParseError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class UnknownVcsProviderError extends Schema.TaggedErrorClass<UnknownVcsProviderError>()(
	"@maple/http/errors/UnknownVcsProviderError",
	{ provider: Schema.String, message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class OAuthStatePersistenceError extends Schema.TaggedErrorClass<OAuthStatePersistenceError>()(
	"@maple/http/errors/OAuthStatePersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}
