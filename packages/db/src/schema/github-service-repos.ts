import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const githubServiceRepos = sqliteTable(
	"github_service_repos",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		serviceName: text("service_name").notNull(),
		repoOwner: text("repo_owner").notNull(),
		repoName: text("repo_name").notNull(),
		createdByUserId: text("created_by_user_id").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("github_service_repos_org_service_idx").on(table.orgId, table.serviceName),
		index("github_service_repos_org_idx").on(table.orgId),
	],
)

export type GithubServiceRepoRow = typeof githubServiceRepos.$inferSelect
export type GithubServiceRepoInsert = typeof githubServiceRepos.$inferInsert
