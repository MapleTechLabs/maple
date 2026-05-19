import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const githubInstallations = sqliteTable(
	"github_installations",
	{
		id: text("id").notNull().primaryKey(),
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
		suspendedAt: integer("suspended_at", { mode: "number" }),
		installedByUserId: text("installed_by_user_id").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("github_installations_org_installation_idx").on(table.orgId, table.installationId),
		index("github_installations_org_idx").on(table.orgId),
		index("github_installations_installation_idx").on(table.installationId),
	],
)

export const githubRepositories = sqliteTable(
	"github_repositories",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		installationId: text("installation_id").notNull(),
		githubRepoId: integer("github_repo_id", { mode: "number" }).notNull(),
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
		uniqueIndex("github_repositories_org_repo_idx").on(table.orgId, table.githubRepoId),
		index("github_repositories_org_installation_idx").on(table.orgId, table.installationId),
	],
)

export const githubCommits = sqliteTable(
	"github_commits",
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
		uniqueIndex("github_commits_org_sha_idx").on(table.orgId, table.sha),
		index("github_commits_org_repo_idx").on(table.orgId, table.repoId),
		index("github_commits_org_committed_idx").on(table.orgId, table.committedAt),
	],
)

export const githubReleases = sqliteTable(
	"github_releases",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		repoId: text("repo_id").notNull(),
		githubReleaseId: integer("github_release_id", { mode: "number" }).notNull(),
		tagName: text("tag_name").notNull(),
		name: text("name"),
		body: text("body"),
		draft: integer("draft", { mode: "boolean" }).notNull().default(false),
		prerelease: integer("prerelease", { mode: "boolean" }).notNull().default(false),
		targetCommitSha: text("target_commit_sha"),
		htmlUrl: text("html_url").notNull(),
		authorLogin: text("author_login"),
		authorAvatarUrl: text("author_avatar_url"),
		publishedAt: integer("published_at", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		syncedAt: integer("synced_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("github_releases_org_release_idx").on(table.orgId, table.githubReleaseId),
		index("github_releases_org_target_sha_idx").on(table.orgId, table.targetCommitSha),
		index("github_releases_org_repo_published_idx").on(table.orgId, table.repoId, table.publishedAt),
	],
)

export const githubUnresolvedShas = sqliteTable(
	"github_unresolved_shas",
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
		uniqueIndex("github_unresolved_shas_org_sha_idx").on(table.orgId, table.sha),
		index("github_unresolved_shas_attempt_idx").on(table.lastAttemptAt),
	],
)

export type GithubInstallationRow = typeof githubInstallations.$inferSelect
export type GithubInstallationInsert = typeof githubInstallations.$inferInsert
export type GithubRepositoryRow = typeof githubRepositories.$inferSelect
export type GithubRepositoryInsert = typeof githubRepositories.$inferInsert
export type GithubCommitRow = typeof githubCommits.$inferSelect
export type GithubCommitInsert = typeof githubCommits.$inferInsert
export type GithubReleaseRow = typeof githubReleases.$inferSelect
export type GithubReleaseInsert = typeof githubReleases.$inferInsert
export type GithubUnresolvedShaRow = typeof githubUnresolvedShas.$inferSelect
export type GithubUnresolvedShaInsert = typeof githubUnresolvedShas.$inferInsert
