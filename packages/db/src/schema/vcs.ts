import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type {
	GitCommitSha,
	VcsAccountType,
	VcsBranchId,
	VcsCommitRowId,
	VcsInstallStatus,
	VcsInstallationId,
	VcsProviderId,
	VcsRepoSelection,
	VcsRepoStatus,
	VcsRepoSyncStatus,
	VcsRepositoryId,
} from "@maple/domain/http"

// ---------------------------------------------------------------------------
// Vendor-agnostic VCS integration tables. Every row carries a `provider`
// discriminator; GitHub-specific concepts never reach this layer. External
// provider ids (installation/repo/account) are stored as TEXT for
// cross-provider generality. Timestamps are epoch milliseconds.
//
// IMPORTANT: only `VcsRepository` (apps/api/src/services/vcs/VcsRepository.ts)
// may import these tables. All other code goes through that repo service.
// ---------------------------------------------------------------------------

/** One row per provider App installation, owned by the initiating Maple org. */
export const vcsInstallations = sqliteTable(
	"vcs_installations",
	{
		id: text("id").$type<VcsInstallationId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		externalInstallationId: text("external_installation_id").notNull(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type").$type<VcsAccountType>().notNull(),
		externalAccountId: text("external_account_id").notNull(),
		accountAvatarUrl: text("account_avatar_url"),
		repositorySelection: text("repository_selection").$type<VcsRepoSelection>().notNull().default("all"),
		status: text("status").$type<VcsInstallStatus>().notNull().default("active"),
		suspendedAt: integer("suspended_at", { mode: "number" }),
		installedByUserId: text("installed_by_user_id").$type<UserId>().notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_installations_provider_external_idx").on(table.provider, table.externalInstallationId),
		index("vcs_installations_org_idx").on(table.orgId),
	],
)

/** Repositories accessible to an installation, plus per-repo sync state. */
export const vcsRepositories = sqliteTable(
	"vcs_repositories",
	{
		id: text("id").$type<VcsRepositoryId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// The owning vcs_installations row, by Maple's internal id (NOT the provider's
		// external installation id). Mirrors vcs_commits.repository_id: the whole VCS
		// tree links by internal id, and a provider's external installation id lives on
		// exactly one row — the installation it identifies — resolved at the
		// sync/webhook boundary into this internal handle.
		installationId: text("installation_id").$type<VcsInstallationId>().notNull(),
		externalRepoId: text("external_repo_id").notNull(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		// The single branch this repo tracks: only its commits are backfilled and
		// ingested. Seeded to `default_branch` on discovery; user-owned thereafter
		// (a reconcile never overwrites it). Nullable so a repo whose tracked branch
		// was deleted can fall back lazily; in practice the sync engine keeps it
		// pinned to a valid branch (falls back to the default on deletion).
		trackedBranch: text("tracked_branch"),
		htmlUrl: text("html_url").notNull(),
		isPrivate: integer("is_private", { mode: "number" }).notNull().default(1),
		isArchived: integer("is_archived", { mode: "number" }).notNull().default(0),
		// Access lifecycle, distinct from sync_status: "active" (visible to the
		// installation) or "removed" (provider revoked access → soft-deleted; row +
		// commits kept, events ignored until re-granted). Hard delete is user-only.
		status: text("status").$type<VcsRepoStatus>().notNull().default("active"),
		syncStatus: text("sync_status").$type<VcsRepoSyncStatus>().notNull().default("pending"),
		lastSyncedAt: integer("last_synced_at", { mode: "number" }),
		lastSyncError: text("last_sync_error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_repositories_org_repo_idx").on(table.orgId, table.provider, table.externalRepoId),
		index("vcs_repositories_org_idx").on(table.orgId),
		index("vcs_repositories_installation_idx").on(table.installationId),
	],
)

/**
 * Resolved commits. Each commit belongs to exactly one `vcs_repositories` row
 * (`repository_id`) — a commit without a repo is not meaningful, and that link
 * is what a repo/installation purge cascades on. There is no branch link: a repo
 * stores the commits of its single tracked branch, so "the repo's commits" is the
 * whole set. The dashboard resolver matches a trace's full 40-char SHA by
 * `(org_id, sha)` — provider-agnostic, no join — so `org_id` stays denormalized
 * here. The row is self-contained (`html_url` + author fields).
 */
export const vcsCommits = sqliteTable(
	"vcs_commits",
	{
		id: text("id").$type<VcsCommitRowId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// The owning repository row. `vcs_repositories` ids are globally unique, so
		// this alone identifies the repo (no org/provider needed in the link). A
		// purge deletes commits by this id; the app refuses to write a commit whose
		// repo row is absent.
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		sha: text("sha").$type<GitCommitSha>().notNull(),
		message: text("message").notNull(),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authorLogin: text("author_login"),
		authorAvatarUrl: text("author_avatar_url"),
		authoredAt: integer("authored_at", { mode: "number" }),
		committedAt: integer("committed_at", { mode: "number" }).notNull(),
		htmlUrl: text("html_url").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		// One row per (repo, sha). repository_id is the leftmost column, so this
		// index also serves the cascade delete's `WHERE repository_id IN (…)`.
		uniqueIndex("vcs_commits_repo_sha_idx").on(table.repositoryId, table.sha),
		index("vcs_commits_org_sha_idx").on(table.orgId, table.sha),
	],
)

/**
 * Branches of a repository (names only — never the commits on them). This table
 * is the picker's list of branches the user can choose to track; which one is
 * tracked is named by `vcs_repositories.tracked_branch`, not a flag here.
 * `is_default` is a display hint (and the default seed for `tracked_branch`).
 */
export const vcsRepositoryBranches = sqliteTable(
	"vcs_repository_branches",
	{
		id: text("id").$type<VcsBranchId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		name: text("name").notNull(),
		isDefault: integer("is_default", { mode: "number" }).notNull().default(0),
		headSha: text("head_sha").$type<GitCommitSha>(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		// One row per (repo, branch name). repository_id leftmost ⇒ also serves the
		// per-repo branch list and the cascade delete's `WHERE repository_id IN (…)`.
		uniqueIndex("vcs_repository_branches_repo_name_idx").on(table.repositoryId, table.name),
		index("vcs_repository_branches_org_idx").on(table.orgId),
	],
)

export type VcsInstallationRow = typeof vcsInstallations.$inferSelect
export type VcsInstallationInsert = typeof vcsInstallations.$inferInsert
export type VcsRepositoryRow = typeof vcsRepositories.$inferSelect
export type VcsRepositoryInsert = typeof vcsRepositories.$inferInsert
export type VcsCommitRow = typeof vcsCommits.$inferSelect
export type VcsCommitInsert = typeof vcsCommits.$inferInsert
export type VcsRepositoryBranchRow = typeof vcsRepositoryBranches.$inferSelect
export type VcsRepositoryBranchInsert = typeof vcsRepositoryBranches.$inferInsert
