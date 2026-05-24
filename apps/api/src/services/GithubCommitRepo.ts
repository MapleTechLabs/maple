import {
	githubCommits,
	githubReleases,
	githubUnresolvedShas,
	type GithubCommitInsert,
	type GithubCommitRow,
	type GithubRepositoryRow,
	type GithubUnresolvedShaRow,
} from "@maple/db"
import { GithubPersistenceError, type OrgId } from "@maple/domain/http"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Array, Context, Effect, Layer, pipe, Schema } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { GithubRepositoryRepo } from "./GithubRepositoryRepo"

// Repository covering commit-derived storage:
//   - github_commits         (primary)
//   - github_releases        (delete-only, used by installation disconnect)
//   - github_unresolved_shas (commit-resolution tombstones)
//
// All three tables share the lifecycle of a connected repository, so they're
// grouped here rather than splitting into three single-method repos.

// Codec for the `branches_json` text column. Stored as JSON-encoded string;
// consumers want ReadonlyArray<string>. Decoded at the repo boundary so the
// raw JSON string never escapes this layer.
const BranchesFromJson = Schema.fromJsonString(Schema.Array(Schema.String))

export type EnrichedCommitRow = Omit<GithubCommitRow, "branchesJson"> & {
	readonly branches: ReadonlyArray<string>
	readonly repo: GithubRepositoryRow | undefined
}

export interface GithubCommitRepoShape {
	readonly findCommitsByShas: (
		orgId: OrgId,
		shas: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<GithubCommitRow>, GithubPersistenceError>
	readonly findEnrichedCommitsByShas: (
		orgId: OrgId,
		shas: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<EnrichedCommitRow>, GithubPersistenceError>
	readonly upsertCommit: (
		insert: GithubCommitInsert,
		options: { readonly refreshBranches: boolean },
	) => Effect.Effect<void, GithubPersistenceError>
	readonly countByRepoForOrg: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyMap<string, number>, GithubPersistenceError>
	readonly deleteByOrgAndRepoIds: (
		orgId: OrgId,
		repoIds: ReadonlyArray<string>,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly deleteReleasesByOrgAndRepoIds: (
		orgId: OrgId,
		repoIds: ReadonlyArray<string>,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly findUnresolvedSha: (
		orgId: OrgId,
		sha: string,
	) => Effect.Effect<GithubUnresolvedShaRow | null, GithubPersistenceError>
	readonly upsertUnresolvedSha: (params: {
		readonly id: string
		readonly orgId: OrgId
		readonly sha: string
		readonly permanent: boolean
		readonly attempt: number
		readonly now: number
	}) => Effect.Effect<void, GithubPersistenceError>
	readonly deleteUnresolvedShasByOrgAndShas: (
		orgId: OrgId,
		shas: ReadonlyArray<string>,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly deleteUnresolvedShasByOrg: (
		orgId: OrgId,
	) => Effect.Effect<void, GithubPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new GithubPersistenceError({
		code: "Database",
		message: error instanceof Error ? error.message : "GitHub commit persistence failed",
	})

export class GithubCommitRepo extends Context.Service<GithubCommitRepo, GithubCommitRepoShape>()(
	"GithubCommitRepo",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const repositoryRepo = yield* GithubRepositoryRepo

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(toPersistenceError))

			// Decode the branches column for a single commit row. The original
			// SchemaError is logged with the offending sha so it stays diagnosable
			// in OTel; the wire-facing error is a clean GithubPersistenceError —
			// corrupt rows are server-side data integrity issues, not user input.
			const decodeBranches = (commitSha: string, branchesJson: string) =>
				Schema.decodeUnknownEffect(BranchesFromJson)(branchesJson).pipe(
					Effect.tapCause((cause) =>
						Effect.logError("Stored branchesJson failed to decode", {
							"commit.sha": commitSha,
							cause,
						}),
					),
					Effect.mapError(
						() =>
							new GithubPersistenceError({
								code: "BranchesDecodeFailed",
								message: `Stored branches for commit ${commitSha} are not valid JSON`,
							}),
					),
				)

			// SQLite caps the IN-clause at ~999 parameters; 50 is a comfortable
			// chunk size that keeps per-request latency low even on long sha lists.
			const findCommitsByShas = Effect.fn("GithubCommitRepo.findCommitsByShas")(function* (
				orgId: OrgId,
				shas: ReadonlyArray<string>,
			) {
				if (shas.length === 0) return [] as ReadonlyArray<GithubCommitRow>
				const chunks = yield* Effect.forEach(
					Array.chunksOf(shas, 50),
					(batch) =>
						dbExecute((db) =>
							db
								.select()
								.from(githubCommits)
								.where(
									and(eq(githubCommits.orgId, orgId), inArray(githubCommits.sha, batch)),
								),
						),
					{ concurrency: 3 },
				)
				return chunks.flat() as ReadonlyArray<GithubCommitRow>
			})

			const findEnrichedCommitsByShas = Effect.fn(
				"GithubCommitRepo.findEnrichedCommitsByShas",
			)(function* (orgId: OrgId, shas: ReadonlyArray<string>) {
				const commits = yield* findCommitsByShas(orgId, shas)

				const distinctRepoIds = pipe(
					commits,
					Array.map((c) => c.repoId),
					Array.dedupe,
				)

				const repos = yield* repositoryRepo.findManyByIds(orgId, distinctRepoIds)
				const repoLookup = new Map(repos.map((r) => [r.id, r]))

				return yield* Effect.forEach(commits, (commit) =>
					decodeBranches(commit.sha, commit.branchesJson).pipe(
						Effect.map((branches) => {
							const { branchesJson: _, ...rest } = commit
							return {
								...rest,
								branches,
								repo: repoLookup.get(commit.repoId),
							} satisfies EnrichedCommitRow
						}),
					),
				)
			})

			const upsertCommit = Effect.fn("GithubCommitRepo.upsertCommit")(function* (
				insert: GithubCommitInsert,
				options: { readonly refreshBranches: boolean },
			) {
				// On conflict, refresh metadata + syncedAt. Only refresh branchesJson
				// when the caller knew which branch these commits live on (push
				// webhook); otherwise preserve whatever's there.
				const updateSet: Partial<GithubCommitInsert> = {
					message: insert.message,
					authorLogin: insert.authorLogin,
					authorName: insert.authorName,
					authorEmail: insert.authorEmail,
					authorAvatarUrl: insert.authorAvatarUrl,
					committerLogin: insert.committerLogin,
					committerName: insert.committerName,
					committerEmail: insert.committerEmail,
					committerAvatarUrl: insert.committerAvatarUrl,
					authoredAt: insert.authoredAt,
					committedAt: insert.committedAt,
					htmlUrl: insert.htmlUrl,
					syncedAt: insert.syncedAt,
				}
				if (options.refreshBranches) updateSet.branchesJson = insert.branchesJson

				yield* dbExecute((db) =>
					db.insert(githubCommits).values(insert).onConflictDoUpdate({
						target: [githubCommits.orgId, githubCommits.sha],
						set: updateSet,
					}),
				)
			})

			const countByRepoForOrg = Effect.fn("GithubCommitRepo.countByRepoForOrg")(function* (
				orgId: OrgId,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select({ repoId: githubCommits.repoId, count: sql<number>`count(*)` })
						.from(githubCommits)
						.where(eq(githubCommits.orgId, orgId))
						.groupBy(githubCommits.repoId),
				)
				return new Map(rows.map((c) => [c.repoId, Number(c.count)])) as ReadonlyMap<
					string,
					number
				>
			})

			const deleteByOrgAndRepoIds = Effect.fn("GithubCommitRepo.deleteByOrgAndRepoIds")(
				function* (orgId: OrgId, repoIds: ReadonlyArray<string>) {
					if (repoIds.length === 0) return
					yield* dbExecute((db) =>
						db
							.delete(githubCommits)
							.where(
								and(eq(githubCommits.orgId, orgId), inArray(githubCommits.repoId, repoIds)),
							),
					)
				},
			)

			const deleteReleasesByOrgAndRepoIds = Effect.fn(
				"GithubCommitRepo.deleteReleasesByOrgAndRepoIds",
			)(function* (orgId: OrgId, repoIds: ReadonlyArray<string>) {
				if (repoIds.length === 0) return
				yield* dbExecute((db) =>
					db
						.delete(githubReleases)
						.where(
							and(eq(githubReleases.orgId, orgId), inArray(githubReleases.repoId, repoIds)),
						),
				)
			})

			const findUnresolvedSha = Effect.fn("GithubCommitRepo.findUnresolvedSha")(function* (
				orgId: OrgId,
				sha: string,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(githubUnresolvedShas)
						.where(
							and(
								eq(githubUnresolvedShas.orgId, orgId),
								eq(githubUnresolvedShas.sha, sha),
							),
						)
						.limit(1),
				)
				return (rows[0] ?? null) as GithubUnresolvedShaRow | null
			})

			const upsertUnresolvedSha = Effect.fn("GithubCommitRepo.upsertUnresolvedSha")(
				function* (params: {
					readonly id: string
					readonly orgId: OrgId
					readonly sha: string
					readonly permanent: boolean
					readonly attempt: number
					readonly now: number
				}) {
					yield* dbExecute((db) =>
						db
							.insert(githubUnresolvedShas)
							.values({
								id: params.id,
								orgId: params.orgId,
								sha: params.sha,
								attemptCount: params.attempt,
								lastAttemptAt: params.now,
								permanent: params.permanent,
								createdAt: params.now,
								updatedAt: params.now,
							})
							.onConflictDoUpdate({
								target: [githubUnresolvedShas.orgId, githubUnresolvedShas.sha],
								set: {
									attemptCount: sql`${githubUnresolvedShas.attemptCount} + 1`,
									lastAttemptAt: params.now,
									permanent: params.permanent,
									updatedAt: params.now,
								},
							}),
					)
				},
			)

			const deleteUnresolvedShasByOrgAndShas = Effect.fn(
				"GithubCommitRepo.deleteUnresolvedShasByOrgAndShas",
			)(function* (orgId: OrgId, shas: ReadonlyArray<string>) {
				if (shas.length === 0) return
				yield* dbExecute((db) =>
					db
						.delete(githubUnresolvedShas)
						.where(
							and(
								eq(githubUnresolvedShas.orgId, orgId),
								inArray(githubUnresolvedShas.sha, shas),
							),
						),
				)
			})

			const deleteUnresolvedShasByOrg = Effect.fn(
				"GithubCommitRepo.deleteUnresolvedShasByOrg",
			)(function* (orgId: OrgId) {
				yield* dbExecute((db) =>
					db.delete(githubUnresolvedShas).where(eq(githubUnresolvedShas.orgId, orgId)),
				)
			})

			return {
				findCommitsByShas,
				findEnrichedCommitsByShas,
				upsertCommit,
				countByRepoForOrg,
				deleteByOrgAndRepoIds,
				deleteReleasesByOrgAndRepoIds,
				findUnresolvedSha,
				upsertUnresolvedSha,
				deleteUnresolvedShasByOrgAndShas,
				deleteUnresolvedShasByOrg,
			} satisfies GithubCommitRepoShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubRepositoryRepo.layer),
	)
}
