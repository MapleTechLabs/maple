import * as PG from "@maple-dev/effect-orm/postgres"
import {
	GitCommitSha,
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewPostMerge,
	PrReviewPostMergeStatus,
	PrReviewReport,
	PrReviewReplyCommand,
	PrReviewReplyId,
	PrReviewReplyStatus,
	PrReviewRepositoryConfig,
	PrReviewSeverity,
	PrReviewSkipReason,
	PrReviewStatus,
	PrReviewTelemetry,
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
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

// Vendor-agnostic VCS integration tables. Every row carries a `provider`
// discriminator; GitHub-specific concepts never reach this layer. External
// provider ids (installation/repo/account) are stored as TEXT for
// cross-provider generality. Timestamps are stored as `timestamptz`.
//
// IMPORTANT: only `VcsRepository` (apps/api/src/services/vcs/VcsRepository.ts)
// may import these tables. All other code goes through that repo service.

/** Where a mention-reply was posted on the pull request. */
export const PrReviewReplySurfaceSchema = Schema.Literals(["conversation", "review_thread"])

/** One row per provider App installation, owned by the initiating Maple org. */
export const VcsInstallations = PG.table("vcs_installations", {
	columns: {
		id: PG.brand(PG.text, VcsInstallationId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, VcsProviderId),
		externalInstallationId: PG.column(PG.text, { name: "external_installation_id" }),
		accountLogin: PG.column(PG.text, { name: "account_login" }),
		accountType: PG.column(PG.brand(PG.text, VcsAccountType), { name: "account_type" }),
		externalAccountId: PG.column(PG.text, { name: "external_account_id" }),
		accountAvatarUrl: PG.column(PG.nullable(PG.text), { name: "account_avatar_url" }),
		repositorySelection: PG.column(PG.brand(PG.text, VcsRepoSelection), {
			name: "repository_selection",
			default: "all",
		}),
		status: PG.column(PG.brand(PG.text, VcsInstallStatus), { default: "active" }),
		suspendedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "suspended_at" }),
		installedByUserId: PG.column(PG.brand(PG.text, UserId), { name: "installed_by_user_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("vcs_installations_provider_external_idx", ["provider", "externalInstallationId"]),
		PG.index("vcs_installations_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

/** Repositories accessible to an installation, plus per-repo sync state. */
export const VcsRepositories = PG.table("vcs_repositories", {
	columns: {
		id: PG.brand(PG.text, VcsRepositoryId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, VcsProviderId),
		// Internal id of the owning vcs_installations row (NOT the provider's external
		// installation id). Provider ids are resolved at the sync/webhook boundary.
		// Deliberately no FK (house style): VcsRepository enforces the link; child
		// upserts share-lock the parent row and no-op when it is gone.
		installationId: PG.column(PG.brand(PG.text, VcsInstallationId), { name: "installation_id" }),
		externalRepoId: PG.column(PG.text, { name: "external_repo_id" }),
		owner: PG.text,
		name: PG.text,
		fullName: PG.column(PG.text, { name: "full_name" }),
		defaultBranch: PG.column(PG.text, { name: "default_branch", default: "main" }),
		// The single branch this repo tracks: only its commits are backfilled and
		// ingested. Seeded to `default_branch` on discovery; user-owned thereafter
		// (a reconcile never overwrites it). Nullable to allow lazy fallback when the
		// tracked branch is deleted.
		trackedBranch: PG.column(PG.nullable(PG.text), { name: "tracked_branch" }),
		htmlUrl: PG.column(PG.text, { name: "html_url" }),
		isPrivate: PG.column(PG.bool, { name: "is_private", default: true }),
		isArchived: PG.column(PG.bool, { name: "is_archived", default: false }),
		// Access lifecycle, distinct from sync_status: "active" (visible to the
		// installation) or "removed" (provider revoked access → soft-deleted; row +
		// commits kept, events ignored until re-granted). Hard delete is user-only.
		status: PG.column(PG.brand(PG.text, VcsRepoStatus), { default: "active" }),
		syncStatus: PG.column(PG.brand(PG.text, VcsRepoSyncStatus), {
			name: "sync_status",
			default: "pending",
		}),
		lastSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_synced_at" }),
		lastSyncError: PG.column(PG.nullable(PG.text), { name: "last_sync_error" }),
		// Opt-in: Maple reviews this repository's pull requests for observability
		// gaps. User-owned, like `tracked_branch`; a reconcile never touches it.
		prReviewEnabled: PG.column(PG.bool, { name: "pr_review_enabled", default: false }),
		/** Review settings for this repository; null reviews with the defaults. */
		prReviewConfig: PG.column(PG.nullable(PG.jsonb(PrReviewRepositoryConfig)), {
			name: "pr_review_config",
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("vcs_repositories_org_repo_idx", ["orgId", "provider", "externalRepoId"]),
		PG.index("vcs_repositories_org_idx", ["orgId"]),
		PG.index("vcs_repositories_installation_idx", ["installationId"]),
	],
	tenantColumn: "orgId",
})

/**
 * Resolved commits. Each commit belongs to exactly one `vcs_repositories` row
 * (`repository_id`); a commit without a repo is not meaningful. There is no FK:
 * VcsRepository enforces the link (purges delete children in the same
 * transaction; child upserts share-lock the parent and no-op when it is gone,
 * and the (org_id, sha) reads join the parent). There is no branch link: a repo
 * stores the commits of its single tracked branch, so "the repo's commits" is the
 * whole set. The dashboard resolver matches a trace's full 40-char SHA by
 * `(org_id, sha)` (provider-agnostic), and `org_id` stays denormalized here so
 * the lookup needs only the orphan-shield join described above. The row is
 * self-contained (`html_url` + author fields).
 */
export const VcsCommits = PG.table("vcs_commits", {
	columns: {
		id: PG.brand(PG.text, VcsCommitRowId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, VcsProviderId),
		// The owning repository row. `vcs_repositories` ids are globally unique so
		// this alone identifies the repo (no org/provider prefix needed in the link).
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		sha: PG.brand(PG.text, GitCommitSha),
		message: PG.text,
		authorName: PG.column(PG.nullable(PG.text), { name: "author_name" }),
		authorEmail: PG.column(PG.nullable(PG.text), { name: "author_email" }),
		authorLogin: PG.column(PG.nullable(PG.text), { name: "author_login" }),
		authorAvatarUrl: PG.column(PG.nullable(PG.text), { name: "author_avatar_url" }),
		authoredAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "authored_at" }),
		committedAt: PG.column(PG.timestamptzMillis, { name: "committed_at" }),
		htmlUrl: PG.column(PG.text, { name: "html_url" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One row per (repo, sha). repository_id is the leftmost column, so this
		// index also serves the cascade delete's `WHERE repository_id IN (…)`.
		PG.uniqueIndex("vcs_commits_repo_sha_idx", ["repositoryId", "sha"]),
		PG.index("vcs_commits_org_sha_idx", ["orgId", "sha"]),
	],
	tenantColumn: "orgId",
})

/**
 * Branches of a repository (names only, never the commits on them). This table
 * is the picker's list of branches the user can choose to track; which one is
 * tracked is named by `vcs_repositories.tracked_branch`, not a flag here.
 * `is_default` is a display hint (and the default seed for `tracked_branch`).
 */
export const VcsRepositoryBranches = PG.table("vcs_repository_branches", {
	columns: {
		id: PG.brand(PG.text, VcsBranchId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, VcsProviderId),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		name: PG.text,
		isDefault: PG.column(PG.bool, { name: "is_default", default: false }),
		headSha: PG.column(PG.nullable(PG.brand(PG.text, GitCommitSha)), { name: "head_sha" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One row per (repo, branch name). repository_id leftmost ⇒ also serves the
		// per-repo branch list and the cascade delete's `WHERE repository_id IN (…)`.
		PG.uniqueIndex("vcs_repository_branches_repo_name_idx", ["repositoryId", "name"]),
		PG.index("vcs_repository_branches_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

/**
 * One observability review of one pull request at one head commit. Written by
 * the review trigger on a `pull_request` webhook, updated by the `pr-review`
 * agent's `submit_review` tool, and read by the settings page. A later push is
 * a new row: GitHub's check run is per head SHA, and so is the review.
 */
export const PrReviews = PG.table("pr_reviews", {
	columns: {
		id: PG.brand(PG.text, PrReviewId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		number: PG.int4,
		headSha: PG.column(PG.brand(PG.text, GitCommitSha), { name: "head_sha" }),
		baseSha: PG.column(PG.nullable(PG.brand(PG.text, GitCommitSha)), { name: "base_sha" }),
		url: PG.text,
		title: PG.nullable(PG.text),
		/** The pull request's author, for the analytics filters; null on rows from before it was kept. */
		authorLogin: PG.column(PG.nullable(PG.text), { name: "author_login" }),
		status: PG.column(PG.brand(PG.text, PrReviewStatus), { default: "queued" }),
		skipReason: PG.column(PG.nullable(PG.brand(PG.text, PrReviewSkipReason)), { name: "skip_reason" }),
		/** The `maple-chat` session (`<orgId>:pr-<id>`), written at insert; read to abort a superseded turn. */
		sessionId: PG.column(PG.nullable(PG.text), { name: "session_id" }),
		/** Bumped when a finished review is asked for again, so the repeat posts a comment of its own. */
		commentAttempt: PG.column(PG.int4, { name: "comment_attempt", default: 0 }),
		/** Structured review; null until `submit_review` lands. */
		reportJson: PG.column(PG.nullable(PG.jsonb(PrReviewReport)), { name: "report_json" }),
		score: PG.nullable(PG.int4),
		checkRunUrl: PG.column(PG.nullable(PG.text), { name: "check_run_url" }),
		commentUrl: PG.column(PG.nullable(PG.text), { name: "comment_url" }),
		reviewUrl: PG.column(PG.nullable(PG.text), { name: "review_url" }),
		/** Set when the review was recorded but GitHub refused the post (a permission not yet granted). */
		publishError: PG.column(PG.nullable(PG.text), { name: "publish_error" }),
		error: PG.nullable(PG.text),
		model: PG.nullable(PG.text),
		inputTokens: PG.column(PG.nullable(PG.int4), { name: "input_tokens" }),
		outputTokens: PG.column(PG.nullable(PG.int4), { name: "output_tokens" }),
		startedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "started_at" }),
		finishedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "finished_at" }),
		/** When the pull request merged, stamped on every review of it by the `closed` event. */
		mergedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "merged_at" }),
		/** What production telemetry said about the change, read when the review started. */
		telemetryJson: PG.column(PG.nullable(PG.jsonb(PrReviewTelemetry)), { name: "telemetry_json" }),
		/** The commit the merge produced; the deploy that carries it is the one the post-merge look reads. */
		mergeCommitSha: PG.column(PG.nullable(PG.text), { name: "merge_commit_sha" }),
		/** The look at production after the merge ships; set on the merged head's review only. */
		postMergeStatus: PG.column(PG.nullable(PG.brand(PG.text, PrReviewPostMergeStatus)), {
			name: "post_merge_status",
		}),
		/** When the post-merge tick next looks at this row. */
		postMergeAfter: PG.column(PG.nullable(PG.timestamptzMillis), { name: "post_merge_after" }),
		/** Stored encoded: the look's timestamps are epoch milliseconds in the JSON. */
		postMergeJson: PG.column(PG.nullable(PG.jsonb(Schema.toEncoded(PrReviewPostMerge))), {
			name: "post_merge_json",
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One review per (repo, PR, head): a webhook redelivery or a `synchronize`
		// that carries the same head must not start a second run.
		PG.uniqueIndex("pr_reviews_repo_number_head_idx", ["repositoryId", "number", "headSha"]),
		// The trigger's "is one already running for this PR" and the settings list.
		PG.index("pr_reviews_repo_number_idx", ["repositoryId", "number"]),
		// The daily quota count.
		PG.index("pr_reviews_org_created_idx", ["orgId", "createdAt"]),
		// The post-merge tick's due rows.
		PG.index("pr_reviews_post_merge_due_idx", ["postMergeAfter"], {
			where: `"post_merge_status" = 'waiting'`,
		}),
	],
	tenantColumn: "orgId",
})

/**
 * One finding a review posted, followed across later pushes of the same pull request so it is
 * never posted twice, is resolved on GitHub when a head fixes it, and stays quiet once a person
 * dismissed it.
 */
export const PrReviewFindings = PG.table("pr_review_findings", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		number: PG.int4,
		/** The review that first posted it. */
		reviewId: PG.column(PG.brand(PG.text, PrReviewId), { name: "review_id" }),
		/** The short handle the reviewer is shown (`F3`), unique per pull request. */
		handle: PG.text,
		path: PG.text,
		line: PG.int4,
		category: PG.brand(PG.text, PrReviewCategory),
		severity: PG.brand(PG.text, PrReviewSeverity),
		title: PG.text,
		status: PG.column(PG.brand(PG.text, PrReviewFindingStatus), { default: "open" }),
		/** The inline review comment's id, when the finding was posted inline. */
		commentId: PG.column(PG.nullable(PG.text), { name: "comment_id" }),
		/** The head that fixed it. */
		resolvedSha: PG.column(PG.nullable(PG.brand(PG.text, GitCommitSha)), { name: "resolved_sha" }),
		/** 👍 / 👎 on the inline comment when last read: the author's verdict, for precision. */
		reactionsUp: PG.column(PG.int4, { name: "reactions_up", default: 0 }),
		reactionsDown: PG.column(PG.int4, { name: "reactions_down", default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("pr_review_findings_pr_handle_idx", ["repositoryId", "number", "handle"]),
		// The analytics window scans and the findings list.
		PG.index("pr_review_findings_org_created_idx", ["orgId", "createdAt"]),
	],
	tenantColumn: "orgId",
})

/**
 * The embedding of a stored finding's text, so a later review can ask whether a new finding looks
 * like the ones this team upvoted or fixed, or the ones it downvoted or dismissed. Kept apart from
 * `pr_review_findings` so the lifecycle reads never carry the vector. `model` names the embedding
 * model: vectors from two models are never compared.
 */
export const PrReviewFindingEmbeddings = PG.table("pr_review_finding_embeddings", {
	columns: {
		/** The `pr_review_findings` row; no FK, like the rest of this file. */
		findingId: PG.column(PG.text, { name: "finding_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		model: PG.text,
		embedding: PG.array(PG.float4),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["findingId"],
	indexes: [PG.index("pr_review_finding_embeddings_org_model_idx", ["orgId", "model"])],
	tenantColumn: "orgId",
})

/**
 * One answer to a pull request comment that mentioned Maple. The comment it answers, and where the
 * answer is posted, are bound here when the webhook lands; the agent never chooses either.
 */
export const PrReviewReplies = PG.table("pr_review_replies", {
	columns: {
		id: PG.brand(PG.text, PrReviewReplyId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		repositoryId: PG.column(PG.brand(PG.text, VcsRepositoryId), { name: "repository_id" }),
		number: PG.int4,
		/** The comment that mentioned Maple; unique per repository so a redelivery answers once. */
		commentId: PG.column(PG.text, { name: "comment_id" }),
		surface: PG.brand(PG.text, PrReviewReplySurfaceSchema),
		threadRootId: PG.column(PG.nullable(PG.text), { name: "thread_root_id" }),
		authorLogin: PG.column(PG.text, { name: "author_login" }),
		command: PG.brand(PG.text, PrReviewReplyCommand),
		/** The head the answer (and a fix commit) is based on. */
		headSha: PG.column(PG.nullable(PG.brand(PG.text, GitCommitSha)), { name: "head_sha" }),
		status: PG.column(PG.brand(PG.text, PrReviewReplyStatus), { default: "queued" }),
		sessionId: PG.column(PG.nullable(PG.text), { name: "session_id" }),
		replyUrl: PG.column(PG.nullable(PG.text), { name: "reply_url" }),
		/** The commit a `fix` pushed to the pull request's branch. */
		commitSha: PG.column(PG.nullable(PG.text), { name: "commit_sha" }),
		error: PG.nullable(PG.text),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("pr_review_replies_repo_comment_idx", ["repositoryId", "commentId"]),
		PG.index("pr_review_replies_org_created_idx", ["orgId", "createdAt"]),
	],
	tenantColumn: "orgId",
})

/** An exact edit a `fix` reply staged; committed together once the reply is submitted. */
export const PrReviewEdits = PG.table("pr_review_edits", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		replyId: PG.column(PG.brand(PG.text, PrReviewReplyId), { name: "reply_id" }),
		seq: PG.int4,
		path: PG.text,
		oldText: PG.column(PG.text, { name: "old_text" }),
		newText: PG.column(PG.text, { name: "new_text" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("pr_review_edits_reply_seq_idx", ["replyId", "seq"])],
	tenantColumn: "orgId",
})

/** Organization-wide review settings, one row per org; no row reviews on the deployment's defaults. */
export const PrReviewSettings = PG.table("pr_review_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/**
		 * The model reviews and replies run on; null uses the deployment's default. Plain text, decoded
		 * on read: a model dropped from the catalog falls back to the default instead of failing.
		 */
		model: PG.nullable(PG.text),
		/** Review rules every repository inherits; a repository's own config overrides field by field. */
		defaults: PG.nullable(PG.jsonb(PrReviewRepositoryConfig)),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type VcsInstallationRow = PG.SelectRowOf<typeof VcsInstallations>
export type VcsInstallationInsert = PG.InsertRowOf<typeof VcsInstallations>
export type VcsRepositoryRow = PG.SelectRowOf<typeof VcsRepositories>
export type VcsRepositoryInsert = PG.InsertRowOf<typeof VcsRepositories>
export type VcsCommitRow = PG.SelectRowOf<typeof VcsCommits>
export type VcsCommitInsert = PG.InsertRowOf<typeof VcsCommits>
export type VcsRepositoryBranchRow = PG.SelectRowOf<typeof VcsRepositoryBranches>
export type VcsRepositoryBranchInsert = PG.InsertRowOf<typeof VcsRepositoryBranches>
export type PrReviewRow = PG.SelectRowOf<typeof PrReviews>
export type PrReviewSettingsRow = PG.SelectRowOf<typeof PrReviewSettings>
export type PrReviewInsert = PG.InsertRowOf<typeof PrReviews>
export type PrReviewFindingRow = PG.SelectRowOf<typeof PrReviewFindings>
export type PrReviewFindingEmbeddingRow = PG.SelectRowOf<typeof PrReviewFindingEmbeddings>
export type PrReviewReplyRow = PG.SelectRowOf<typeof PrReviewReplies>
export type PrReviewEditRow = PG.SelectRowOf<typeof PrReviewEdits>
