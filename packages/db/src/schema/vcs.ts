import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type {
	GitCommitSha,
	VcsAccountType,
	VcsCommitRowId,
	VcsInstallStatus,
	VcsInstallationId,
	VcsProviderId,
	VcsRepoSelection,
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

/** Repositories accessible to an installation, plus a per-repo sync cursor. */
export const vcsRepositories = sqliteTable(
	"vcs_repositories",
	{
		id: text("id").$type<VcsRepositoryId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		externalInstallationId: text("external_installation_id").notNull(),
		externalRepoId: text("external_repo_id").notNull(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		htmlUrl: text("html_url").notNull(),
		isPrivate: integer("is_private", { mode: "number" }).notNull().default(1),
		isArchived: integer("is_archived", { mode: "number" }).notNull().default(0),
		syncStatus: text("sync_status").$type<VcsRepoSyncStatus>().notNull().default("pending"),
		lastSyncedAt: integer("last_synced_at", { mode: "number" }),
		lastSyncCursor: text("last_sync_cursor"),
		lastSyncError: text("last_sync_error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_repositories_org_repo_idx").on(table.orgId, table.provider, table.externalRepoId),
		index("vcs_repositories_org_idx").on(table.orgId),
		index("vcs_repositories_installation_idx").on(table.provider, table.externalInstallationId),
	],
)

/**
 * Resolved commits. The dashboard resolver matches a trace's full 40-char SHA
 * by `(org_id, sha)` — provider-agnostic. The row is self-contained
 * (`html_url` + author fields) so the resolver needs no join.
 */
export const vcsCommits = sqliteTable(
	"vcs_commits",
	{
		id: text("id").$type<VcsCommitRowId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		externalRepoId: text("external_repo_id").notNull(),
		sha: text("sha").$type<GitCommitSha>().notNull(),
		message: text("message").notNull(),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authorLogin: text("author_login"),
		authorAvatarUrl: text("author_avatar_url"),
		authoredAt: integer("authored_at", { mode: "number" }),
		committedAt: integer("committed_at", { mode: "number" }).notNull(),
		htmlUrl: text("html_url").notNull(),
		branch: text("branch"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_commits_org_repo_sha_idx").on(table.orgId, table.provider, table.externalRepoId, table.sha),
		index("vcs_commits_org_sha_idx").on(table.orgId, table.sha),
	],
)

export type VcsInstallationRow = typeof vcsInstallations.$inferSelect
export type VcsInstallationInsert = typeof vcsInstallations.$inferInsert
export type VcsRepositoryRow = typeof vcsRepositories.$inferSelect
export type VcsRepositoryInsert = typeof vcsRepositories.$inferInsert
export type VcsCommitRow = typeof vcsCommits.$inferSelect
export type VcsCommitInsert = typeof vcsCommits.$inferInsert
