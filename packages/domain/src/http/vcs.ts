import { Schema } from "effect"
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
 * A full 40-char, lowercase-hex git commit SHA. Strict — unlike the permissive
 * telemetry `CommitSha` brand (which must not throw on arbitrary OTel data) —
 * so the SHA-shape regex lives in exactly this one declarative type. Decoding a
 * value through it (at the webhook/REST boundary and on persistence) is the only
 * SHA validation in the codebase.
 */
export const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
	Schema.brand("@maple/GitCommitSha"),
	Schema.annotate({ identifier: "@maple/GitCommitSha", title: "Git Commit SHA" }),
)
export type GitCommitSha = Schema.Schema.Type<typeof GitCommitSha>

/** First 7 hex chars of a commit SHA (display + abbreviated-input lookup). */
export const ShortCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7}$/)).pipe(
	Schema.brand("@maple/ShortCommitSha"),
	Schema.annotate({ identifier: "@maple/ShortCommitSha", title: "Short Commit SHA" }),
)
export type ShortCommitSha = Schema.Schema.Type<typeof ShortCommitSha>

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
	lastSyncCursor: Schema.NullOr(Schema.String),
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
	shortSha: ShortCommitSha,
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
})
export type BackfillRepoJob = Schema.Schema.Type<typeof BackfillRepoJob>

export const PushDeltaJob = Schema.Struct({
	kind: Schema.Literal("push-delta"),
	provider: VcsProviderId,
	externalInstallationId: Schema.String,
	externalRepoId: Schema.String,
	branch: Schema.String,
	commits: Schema.Array(CommitUpsertInput),
})
export type PushDeltaJob = Schema.Schema.Type<typeof PushDeltaJob>

export const VcsSyncJob = Schema.Union([InstallationSyncJob, BackfillRepoJob, PushDeltaJob])
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
