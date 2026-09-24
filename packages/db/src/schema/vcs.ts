import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type {
	GitCommitSha,
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewReport,
	PrReviewReplyCommand,
	PrReviewReplyId,
	PrReviewReplyStatus,
	PrReviewRepositoryConfig,
	PrReviewSeverity,
	PrReviewSkipReason,
	PrReviewStatus,
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

// Vendor-agnostic VCS integration tables. Every row carries a `provider`
// discriminator; GitHub-specific concepts never reach this layer. External
// provider ids (installation/repo/account) are stored as TEXT for
// cross-provider generality. Timestamps are stored as `timestamptz`.
//
// IMPORTANT: only `VcsRepository` (apps/api/src/services/vcs/VcsRepository.ts)
// may import these tables. All other code goes through that repo service.

/** One row per provider App installation, owned by the initiating Maple org. */
export const vcsInstallations = pgTable(
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
		suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }),
		installedByUserId: text("installed_by_user_id").$type<UserId>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_installations_provider_external_idx").on(
			table.provider,
			table.externalInstallationId,
		),
		index("vcs_installations_org_idx").on(table.orgId),
	],
)

/** Repositories accessible to an installation, plus per-repo sync state. */
export const vcsRepositories = pgTable(
	"vcs_repositories",
	{
		id: text("id").$type<VcsRepositoryId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// Internal id of the owning vcs_installations row (NOT the provider's external
		// installation id). Provider ids are resolved at the sync/webhook boundary.
		// Deliberately no FK (house style): VcsRepository enforces the link — child
		// upserts share-lock the parent row and no-op when it is gone.
		installationId: text("installation_id").$type<VcsInstallationId>().notNull(),
		externalRepoId: text("external_repo_id").notNull(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		// The single branch this repo tracks: only its commits are backfilled and
		// ingested. Seeded to `default_branch` on discovery; user-owned thereafter
		// (a reconcile never overwrites it). Nullable to allow lazy fallback when the
		// tracked branch is deleted.
		trackedBranch: text("tracked_branch"),
		htmlUrl: text("html_url").notNull(),
		isPrivate: boolean("is_private").notNull().default(true),
		isArchived: boolean("is_archived").notNull().default(false),
		// Access lifecycle, distinct from sync_status: "active" (visible to the
		// installation) or "removed" (provider revoked access → soft-deleted; row +
		// commits kept, events ignored until re-granted). Hard delete is user-only.
		status: text("status").$type<VcsRepoStatus>().notNull().default("active"),
		syncStatus: text("sync_status").$type<VcsRepoSyncStatus>().notNull().default("pending"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
		lastSyncError: text("last_sync_error"),
		// Opt-in: Maple reviews this repository's pull requests for observability
		// gaps. User-owned, like `tracked_branch`; a reconcile never touches it.
		prReviewEnabled: boolean("pr_review_enabled").notNull().default(false),
		/** Review settings for this repository; null reviews with the defaults. */
		prReviewConfig: jsonb("pr_review_config").$type<PrReviewRepositoryConfig>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_repositories_org_repo_idx").on(table.orgId, table.provider, table.externalRepoId),
		index("vcs_repositories_org_idx").on(table.orgId),
		index("vcs_repositories_installation_idx").on(table.installationId),
	],
)

/**
 * Resolved commits. Each commit belongs to exactly one `vcs_repositories` row
 * (`repository_id`) — a commit without a repo is not meaningful. There is no FK:
 * VcsRepository enforces the link (purges delete children in the same
 * transaction; child upserts share-lock the parent and no-op when it is gone,
 * and the (org_id, sha) reads join the parent). There is no branch link: a repo
 * stores the commits of its single tracked branch, so "the repo's commits" is the
 * whole set. The dashboard resolver matches a trace's full 40-char SHA by
 * `(org_id, sha)` — provider-agnostic, and `org_id` stays denormalized here so
 * the lookup needs only the orphan-shield join described above. The row is
 * self-contained (`html_url` + author fields).
 */
export const vcsCommits = pgTable(
	"vcs_commits",
	{
		id: text("id").$type<VcsCommitRowId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// The owning repository row. `vcs_repositories` ids are globally unique so
		// this alone identifies the repo (no org/provider prefix needed in the link).
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		sha: text("sha").$type<GitCommitSha>().notNull(),
		message: text("message").notNull(),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authorLogin: text("author_login"),
		authorAvatarUrl: text("author_avatar_url"),
		authoredAt: timestamp("authored_at", { withTimezone: true, mode: "date" }),
		committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }).notNull(),
		htmlUrl: text("html_url").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
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
export const vcsRepositoryBranches = pgTable(
	"vcs_repository_branches",
	{
		id: text("id").$type<VcsBranchId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		name: text("name").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		headSha: text("head_sha").$type<GitCommitSha>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One row per (repo, branch name). repository_id leftmost ⇒ also serves the
		// per-repo branch list and the cascade delete's `WHERE repository_id IN (…)`.
		uniqueIndex("vcs_repository_branches_repo_name_idx").on(table.repositoryId, table.name),
		index("vcs_repository_branches_org_idx").on(table.orgId),
	],
)

/**
 * One observability review of one pull request at one head commit. Written by
 * the review trigger on a `pull_request` webhook, updated by the `pr-review`
 * agent's `submit_review` tool, and read by the settings page. A later push is
 * a new row: GitHub's check run is per head SHA, and so is the review.
 */
export const prReviews = pgTable(
	"pr_reviews",
	{
		id: text("id").$type<PrReviewId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		number: integer("number").notNull(),
		headSha: text("head_sha").$type<GitCommitSha>().notNull(),
		baseSha: text("base_sha").$type<GitCommitSha>(),
		url: text("url").notNull(),
		title: text("title"),
		status: text("status").$type<PrReviewStatus>().notNull().default("queued"),
		skipReason: text("skip_reason").$type<PrReviewSkipReason>(),
		/** The `maple-chat` session (`<orgId>:pr-<id>`), written at insert; read to abort a superseded turn. */
		sessionId: text("session_id"),
		/** Bumped when a finished review is asked for again, so the repeat posts a comment of its own. */
		commentAttempt: integer("comment_attempt").notNull().default(0),
		/** Structured review; null until `submit_review` lands. */
		reportJson: jsonb("report_json").$type<PrReviewReport>(),
		score: integer("score"),
		checkRunUrl: text("check_run_url"),
		commentUrl: text("comment_url"),
		reviewUrl: text("review_url"),
		/** Set when the review was recorded but GitHub refused the post (a permission not yet granted). */
		publishError: text("publish_error"),
		error: text("error"),
		model: text("model"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One review per (repo, PR, head): a webhook redelivery or a `synchronize`
		// that carries the same head must not start a second run.
		uniqueIndex("pr_reviews_repo_number_head_idx").on(table.repositoryId, table.number, table.headSha),
		// The trigger's "is one already running for this PR" and the settings list.
		index("pr_reviews_repo_number_idx").on(table.repositoryId, table.number),
		// The daily quota count.
		index("pr_reviews_org_created_idx").on(table.orgId, table.createdAt),
	],
)

/**
 * One finding a review posted, followed across later pushes of the same pull request so it is
 * never posted twice, is resolved on GitHub when a head fixes it, and stays quiet once a person
 * dismissed it.
 */
export const prReviewFindings = pgTable(
	"pr_review_findings",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		number: integer("number").notNull(),
		/** The review that first posted it. */
		reviewId: text("review_id").$type<PrReviewId>().notNull(),
		/** The short handle the reviewer is shown (`F3`), unique per pull request. */
		handle: text("handle").notNull(),
		path: text("path").notNull(),
		line: integer("line").notNull(),
		category: text("category").$type<PrReviewCategory>().notNull(),
		severity: text("severity").$type<PrReviewSeverity>().notNull(),
		title: text("title").notNull(),
		status: text("status").$type<PrReviewFindingStatus>().notNull().default("open"),
		/** The inline review comment's id, when the finding was posted inline. */
		commentId: text("comment_id"),
		/** The head that fixed it. */
		resolvedSha: text("resolved_sha").$type<GitCommitSha>(),
		/** 👍 / 👎 on the inline comment when last read: the author's verdict, for precision. */
		reactionsUp: integer("reactions_up").notNull().default(0),
		reactionsDown: integer("reactions_down").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("pr_review_findings_pr_handle_idx").on(table.repositoryId, table.number, table.handle),
		index("pr_review_findings_org_idx").on(table.orgId),
	],
)

/**
 * The embedding of a stored finding's text, so a later review can ask whether a new finding looks
 * like the ones this team upvoted or fixed, or the ones it downvoted or dismissed. Kept apart from
 * `pr_review_findings` so the lifecycle reads never carry the vector. `model` names the embedding
 * model: vectors from two models are never compared.
 */
export const prReviewFindingEmbeddings = pgTable(
	"pr_review_finding_embeddings",
	{
		/** The `pr_review_findings` row; no FK, like the rest of this file. */
		findingId: text("finding_id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		model: text("model").notNull(),
		embedding: real("embedding").array().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [index("pr_review_finding_embeddings_org_model_idx").on(table.orgId, table.model)],
)

/**
 * One answer to a pull request comment that mentioned Maple. The comment it answers, and where the
 * answer is posted, are bound here when the webhook lands; the agent never chooses either.
 */
export const prReviewReplies = pgTable(
	"pr_review_replies",
	{
		id: text("id").$type<PrReviewReplyId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		number: integer("number").notNull(),
		/** The comment that mentioned Maple; unique per repository so a redelivery answers once. */
		commentId: text("comment_id").notNull(),
		surface: text("surface").$type<"conversation" | "review_thread">().notNull(),
		threadRootId: text("thread_root_id"),
		authorLogin: text("author_login").notNull(),
		command: text("command").$type<PrReviewReplyCommand>().notNull(),
		/** The head the answer (and a fix commit) is based on. */
		headSha: text("head_sha").$type<GitCommitSha>(),
		status: text("status").$type<PrReviewReplyStatus>().notNull().default("queued"),
		sessionId: text("session_id"),
		replyUrl: text("reply_url"),
		/** The commit a `fix` pushed to the pull request's branch. */
		commitSha: text("commit_sha"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("pr_review_replies_repo_comment_idx").on(table.repositoryId, table.commentId),
		index("pr_review_replies_org_created_idx").on(table.orgId, table.createdAt),
	],
)

/** An exact edit a `fix` reply staged; committed together once the reply is submitted. */
export const prReviewEdits = pgTable(
	"pr_review_edits",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		replyId: text("reply_id").$type<PrReviewReplyId>().notNull(),
		seq: integer("seq").notNull(),
		path: text("path").notNull(),
		oldText: text("old_text").notNull(),
		newText: text("new_text").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [uniqueIndex("pr_review_edits_reply_seq_idx").on(table.replyId, table.seq)],
)

export type VcsInstallationRow = typeof vcsInstallations.$inferSelect
export type VcsInstallationInsert = typeof vcsInstallations.$inferInsert
export type VcsRepositoryRow = typeof vcsRepositories.$inferSelect
export type VcsRepositoryInsert = typeof vcsRepositories.$inferInsert
export type VcsCommitRow = typeof vcsCommits.$inferSelect
export type VcsCommitInsert = typeof vcsCommits.$inferInsert
export type VcsRepositoryBranchRow = typeof vcsRepositoryBranches.$inferSelect
export type VcsRepositoryBranchInsert = typeof vcsRepositoryBranches.$inferInsert
export type PrReviewRow = typeof prReviews.$inferSelect
export type PrReviewInsert = typeof prReviews.$inferInsert
export type PrReviewFindingRow = typeof prReviewFindings.$inferSelect
export type PrReviewFindingEmbeddingRow = typeof prReviewFindingEmbeddings.$inferSelect
export type PrReviewReplyRow = typeof prReviewReplies.$inferSelect
export type PrReviewEditRow = typeof prReviewEdits.$inferSelect
