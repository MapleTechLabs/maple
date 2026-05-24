import {
	oauthAuthStates,
	type OAuthAuthStateInsert,
	type OAuthAuthStateRow,
} from "@maple/db"
import { GithubPersistenceError } from "@maple/domain/http"
import { eq, lt } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"

// Single-provider repository for `oauthAuthStates` rows that belong to the
// github install flow. The underlying table is provider-tagged (`provider`
// column) so it could host other providers later (Hazel currently uses its
// own bespoke storage); when a second provider needs the same table we'll
// rename this to `OauthAuthStateRepo` and pass `provider` as an argument.
// Today: every method is scoped to `provider = "github"` implicitly.

const GITHUB_PROVIDER = "github"

export interface GithubOauthAuthStateRepoShape {
	readonly purgeExpired: (now: number) => Effect.Effect<void, GithubPersistenceError>
	readonly insert: (
		row: Omit<OAuthAuthStateInsert, "provider">,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly findByState: (
		state: string,
	) => Effect.Effect<OAuthAuthStateRow | null, GithubPersistenceError>
	readonly deleteByState: (state: string) => Effect.Effect<void, GithubPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new GithubPersistenceError({
		code: "Database",
		message:
			error instanceof Error ? error.message : "GitHub oauth state persistence failed",
	})

export class GithubOauthAuthStateRepo extends Context.Service<
	GithubOauthAuthStateRepo,
	GithubOauthAuthStateRepoShape
>()("GithubOauthAuthStateRepo", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const purgeExpired = Effect.fn("GithubOauthAuthStateRepo.purgeExpired")(function* (
			now: number,
		) {
			yield* dbExecute((db) =>
				db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, now)),
			)
		})

		const insert = Effect.fn("GithubOauthAuthStateRepo.insert")(function* (
			row: Omit<OAuthAuthStateInsert, "provider">,
		) {
			yield* dbExecute((db) =>
				db.insert(oauthAuthStates).values({ ...row, provider: GITHUB_PROVIDER }),
			)
		})

		const findByState = Effect.fn("GithubOauthAuthStateRepo.findByState")(function* (
			state: string,
		) {
			const rows = yield* dbExecute((db) =>
				db.select().from(oauthAuthStates).where(eq(oauthAuthStates.state, state)).limit(1),
			)
			return (rows[0] ?? null) as OAuthAuthStateRow | null
		})

		const deleteByState = Effect.fn("GithubOauthAuthStateRepo.deleteByState")(function* (
			state: string,
		) {
			yield* dbExecute((db) =>
				db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
			)
		})

		return {
			purgeExpired,
			insert,
			findByState,
			deleteByState,
		} satisfies GithubOauthAuthStateRepoShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
