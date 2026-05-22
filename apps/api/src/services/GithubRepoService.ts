import { Array, Context, Effect, Layer, pipe } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { githubCommits, githubRepositories } from "@maple/db"
import { and, eq, inArray } from "drizzle-orm"
import { IntegrationsPersistenceError, OrgId } from "@maple/domain/http"

type FindCommitsByShasProps = {
	orgId: OrgId
	shas: ReadonlyArray<string>
}

type FindRepositoriesByIdsProps = {
	orgId: OrgId
	repoIds: ReadonlyArray<string>
}

type FindEnrichedCommitsByShasProps = {
	orgId: OrgId
	shas: ReadonlyArray<string>
}

export class GithubRepoService extends Context.Service<GithubRepoService>()("GithubRepoService", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>, defaultErrorMessage: string) =>
			database.execute(fn).pipe(
				Effect.mapError(
					(error) =>
						new IntegrationsPersistenceError({
							message: error instanceof Error ? error.message : defaultErrorMessage,
						}),
				),
			)

		const findRepositoriesByIds = Effect.fn("GithubRepoService.findRepositoriesByIds")(function* ({
			orgId,
			repoIds,
		}: FindRepositoriesByIdsProps) {
			if (repoIds.length === 0) return []

			return yield* Effect.forEach(Array.chunksOf(repoIds, 50), (batch) =>
				dbExecute(
					(db) =>
						db
							.select()
							.from(githubRepositories)
							.where(
								and(
									eq(githubRepositories.orgId, orgId),
									inArray(githubRepositories.id, batch),
								),
							),
					"Repositories lookup database error",
				),
			).pipe(Effect.map(Array.flatten))
		})

		const findCommitsByShas = Effect.fn("GithubRepoService.findCommitsByShas")(function* ({
			orgId,
			shas,
		}: FindCommitsByShasProps) {
			if (shas.length === 0) return []

			return yield* Effect.forEach(
				Array.chunksOf(shas, 50),
				(batch) =>
					dbExecute(
						(db) =>
							db
								.select()
								.from(githubCommits)
								.where(
									and(eq(githubCommits.orgId, orgId), inArray(githubCommits.sha, batch)),
								),
						"Commits lookup database error",
					),
				{ concurrency: 3 },
			).pipe(Effect.map(Array.flatten))
		})

		const findEnrichedCommitsByShas = Effect.fn("GithubRepoService.findEnrichedCommitsByShas")(
			function* ({ orgId, shas }: FindEnrichedCommitsByShasProps) {
				const commits = yield* findCommitsByShas({ orgId, shas })

				const distinctRepoIds = pipe(
					commits,
					Array.map((c) => c.repoId),
					Array.dedupe,
				)

				const repos = yield* findRepositoriesByIds({ orgId, repoIds: distinctRepoIds })
				const repoLookup = new Map(repos.map((r) => [r.id, r]))

				return commits.map((commit) => ({
					...commit,
					repo: repoLookup.get(commit.repoId),
				}))
			},
		)

		return {
			findCommitsByShas,
			findRepositoriesByIds,
			findEnrichedCommitsByShas,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
