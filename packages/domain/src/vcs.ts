// Stored shapes shared by the HTTP contract (`./http/vcs.ts`) and the Postgres tables.

import { Schema, SchemaGetter, String as Str } from "effect"

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

export const VcsBranchId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/VcsBranchId"),
	Schema.annotate({ identifier: "@maple/VcsBranchId", title: "VCS Branch ID" }),
)
export type VcsBranchId = Schema.Schema.Type<typeof VcsBranchId>

/**
 * A full 40-char git commit SHA. Case-insensitive on input and normalized to
 * lowercase during decode, so the same commit is identified regardless of the
 * case a provider — or an OTel `vcs.ref.head.revision` attribute — emits it in.
 * Strict — unlike the permissive telemetry `CommitSha` brand (which must not
 * throw on arbitrary OTel data) — so the SHA-shape regex lives in exactly this
 * one declarative type, validated at the webhook/REST boundary and on persistence.
 *
 * (40 hex = git's SHA-1 object format; git's experimental SHA-256 object format
 * — 64 hex — is a known, currently-unused limitation across every git host.)
 */
const GitCommitShaBrand = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)).pipe(
	Schema.brand("@maple/GitCommitSha"),
)
export const GitCommitSha = Schema.String.pipe(
	// Lowercase before the pattern check so `aBc…` and `ABC…` resolve to the same branded value.
	Schema.decodeTo(GitCommitShaBrand, {
		decode: SchemaGetter.transform((s: string) => Str.toLowerCase(s)),
		encode: SchemaGetter.passthrough<string>(),
	}),
	Schema.annotate({ identifier: "@maple/GitCommitSha", title: "Git Commit SHA" }),
)
export type GitCommitSha = Schema.Schema.Type<typeof GitCommitSha>

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

/** Completion of the repository enumeration requested by one connect operation. */
export const VcsRepositoryDiscovery = Schema.Union([
	Schema.TaggedStruct("Pending", { requestId: Schema.String }),
	Schema.TaggedStruct("Complete", { requestId: Schema.String }),
	Schema.TaggedStruct("Failed", { requestId: Schema.String, message: Schema.String }),
])
export type VcsRepositoryDiscovery = Schema.Schema.Type<typeof VcsRepositoryDiscovery>

export const VcsRepoSyncStatus = Schema.Literals(["pending", "backfilling", "ready", "error"]).annotate({
	identifier: "@maple/VcsRepoSyncStatus",
	title: "VCS Repository Sync Status",
})
export type VcsRepoSyncStatus = Schema.Schema.Type<typeof VcsRepoSyncStatus>

/**
 * A repository's lifecycle (access) state — orthogonal to its `syncStatus`.
 * `active`: the installation can currently see the repo. `removed`: the provider
 * revoked access (a GitHub `installation_repositories` removed event), so the
 * repo is soft-deleted — its row and synced commits are kept, but no further
 * events are processed for it until access is re-granted (which flips it back to
 * `active`). A hard delete is user-initiated only.
 */
export const VcsRepoStatus = Schema.Literals(["active", "removed"]).annotate({
	identifier: "@maple/VcsRepoStatus",
	title: "VCS Repository Status",
})
export type VcsRepoStatus = Schema.Schema.Type<typeof VcsRepoStatus>

// GitHub's shapes: an owner is alphanumerics and hyphens, a name is never `.` or `..`.
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/u

/** A repository as `owner/name`. */
export const RepoFullName = Schema.String.check(Schema.isPattern(REPO_FULL_NAME_PATTERN))
