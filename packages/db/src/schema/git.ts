import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const gitInstallations = sqliteTable(
	"git_installations",
	{
		id: text("id").notNull().primaryKey(),

		// The ID of the organisation this installation is scoped to. 
		orgId: text("org_id").notNull(),
		installationId: integer("installation_id", { mode: "number" }).notNull(),
		appSlug: text("app_slug").notNull(),
		accountId: integer("account_id", { mode: "number" }).notNull(),
		accountLogin: text("account_login").notNull(),
		accountAvatarUrl: text("account_avatar_url"),
		accountType: text("account_type").notNull(),
		targetType: text("target_type").notNull(),
		repositorySelection: text("repository_selection").notNull(),
		permissionsJson: text("permissions_json").notNull().default("{}"),
		eventsJson: text("events_json").notNull().default("[]"),
		installedByUserId: text("installed_by_user_id").notNull(),

		// Users can suspend an installation in the dashboard. This will stop all data syncing.
		suspendedAt: integer("suspended_at", { mode: "number" }),

		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("git_installations_org_installation_idx").on(table.orgId, table.installationId),
		index("git_installations_org_idx").on(table.orgId),
		index("git_installations_installation_idx").on(table.installationId),
	],
)

export const gitRepositories = sqliteTable(
	"git_repositories",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		installationId: text("installation_id").notNull(),
		gitRepoId: integer("git_repo_id", { mode: "number" }).notNull(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		defaultBranch: text("default_branch").notNull(),
		private: integer("private", { mode: "boolean" }).notNull().default(false),
		htmlUrl: text("html_url").notNull(),
		syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(true),
		lastSyncedAt: integer("last_synced_at", { mode: "number" }),
		lastFullBackfillAt: integer("last_full_backfill_at", { mode: "number" }),
		backfillStatus: text("backfill_status").notNull().default("pending"),
		backfillError: text("backfill_error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("git_repositories_org_repo_idx").on(table.orgId, table.gitRepoId),
		index("git_repositories_org_installation_idx").on(table.orgId, table.installationId),
	],
)

export const gitCommits = sqliteTable(
	"git_commits",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		repoId: text("repo_id").notNull(),
		sha: text("sha").notNull(),
		shortSha: text("short_sha").notNull(),
		message: text("message").notNull().default(""),
		authorLogin: text("author_login"),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authorAvatarUrl: text("author_avatar_url"),
		committerLogin: text("committer_login"),
		committerName: text("committer_name"),
		committerEmail: text("committer_email"),
		committerAvatarUrl: text("committer_avatar_url"),
		authoredAt: integer("authored_at", { mode: "number" }).notNull(),
		committedAt: integer("committed_at", { mode: "number" }).notNull(),
		htmlUrl: text("html_url").notNull(),
		branchesJson: text("branches_json").notNull().default("[]"),
		prNumber: integer("pr_number", { mode: "number" }),
		syncedAt: integer("synced_at", { mode: "number" }).notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("git_commits_org_sha_idx").on(table.orgId, table.sha),
		index("git_commits_org_repo_idx").on(table.orgId, table.repoId),
		index("git_commits_org_committed_idx").on(table.orgId, table.committedAt),
	],
)

export const gitUnresolvedShas = sqliteTable(
	"git_unresolved_shas",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		sha: text("sha").notNull(),
		attemptCount: integer("attempt_count", { mode: "number" }).notNull().default(0),
		lastAttemptAt: integer("last_attempt_at", { mode: "number" }).notNull(),
		permanent: integer("permanent", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("git_unresolved_shas_org_sha_idx").on(table.orgId, table.sha),
		index("git_unresolved_shas_attempt_idx").on(table.lastAttemptAt),
	],
)

export type GitInstallationRow = typeof gitInstallations.$inferSelect
export type GitInstallationInsert = typeof gitInstallations.$inferInsert
export type GitRepositoryRow = typeof gitRepositories.$inferSelect
export type GitRepositoryInsert = typeof gitRepositories.$inferInsert
export type GitCommitRow = typeof gitCommits.$inferSelect
export type GitCommitInsert = typeof gitCommits.$inferInsert
export type GitUnresolvedShaRow = typeof gitUnresolvedShas.$inferSelect
export type GitUnresolvedShaInsert = typeof gitUnresolvedShas.$inferInsert
