import {
	githubRepositories,
	type GithubRepositoryInsert,
	type GithubRepositoryRow,
} from "@maple/db"
import {
	GithubBackfillStatus,
	GithubPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"

// Single-table repository for `github_repositories`. Update operations all go
// through `updateById(id, patch)` rather than per-field methods to avoid
// adding a new method every time we need to set a new column.

// `backfillStatus` is stored as plain text but the domain treats it as a
// typed literal. Decoding at the repo boundary means consumers never do
// defensive coercion ladders and corrupt rows fail loud as typed errors.
export type DecodedGithubRepositoryRow = Omit<GithubRepositoryRow, "backfillStatus"> & {
	readonly backfillStatus: GithubBackfillStatus
}

export interface GithubRepositoryRepoShape {
	readonly findByOrgAndDbId: (
		orgId: OrgId,
		dbId: string,
	) => Effect.Effect<DecodedGithubRepositoryRow | null, GithubPersistenceError>
	readonly findByOrgAndGithubRepoId: (
		orgId: OrgId,
		githubRepoId: number,
	) => Effect.Effect<DecodedGithubRepositoryRow | null, GithubPersistenceError>
	readonly findByOrgAndOwnerName: (
		orgId: OrgId,
		owner: string,
		name: string,
	) => Effect.Effect<DecodedGithubRepositoryRow | null, GithubPersistenceError>
	readonly listByOrgAndInstallation: (
		orgId: OrgId,
		installationDbId: string,
	) => Effect.Effect<ReadonlyArray<DecodedGithubRepositoryRow>, GithubPersistenceError>
	readonly listIdsByOrgAndInstallation: (
		orgId: OrgId,
		installationDbId: string,
	) => Effect.Effect<ReadonlyArray<string>, GithubPersistenceError>
	readonly countByInstallationForOrg: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyMap<string, number>, GithubPersistenceError>
	readonly insert: (row: GithubRepositoryInsert) => Effect.Effect<void, GithubPersistenceError>
	readonly updateById: (
		id: string,
		patch: Partial<GithubRepositoryInsert>,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly deleteByOrgAndInstallation: (
		orgId: OrgId,
		installationDbId: string,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly findManyByIds: (
		orgId: OrgId,
		ids: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<DecodedGithubRepositoryRow>, GithubPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new GithubPersistenceError({
		code: "Database",
		message: error instanceof Error ? error.message : "GitHub repository persistence failed",
	})

const decodeBackfillStatus = Schema.decodeUnknownEffect(GithubBackfillStatus)

const decodeRow = (row: GithubRepositoryRow) =>
	decodeBackfillStatus(row.backfillStatus).pipe(
		Effect.map((backfillStatus) => ({ ...row, backfillStatus }) satisfies DecodedGithubRepositoryRow),
		Effect.tapCause((cause) =>
			Effect.logError("Stored repository row failed enum decode", {
				"repository.id": row.id,
				"repository.backfillStatus": row.backfillStatus,
				cause,
			}),
		),
		Effect.mapError(
			() =>
				new GithubPersistenceError({
					code: "RepositoryRowDecodeFailed",
					message: `Stored repository ${row.id} has invalid backfillStatus`,
				}),
		),
	)

const decodeRows = (rows: ReadonlyArray<GithubRepositoryRow>) => Effect.forEach(rows, decodeRow)

export class GithubRepositoryRepo extends Context.Service<
	GithubRepositoryRepo,
	GithubRepositoryRepoShape
>()("GithubRepositoryRepo", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const findByOrgAndDbId = Effect.fn("GithubRepositoryRepo.findByOrgAndDbId")(function* (
			orgId: OrgId,
			dbId: string,
		) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(githubRepositories)
					.where(and(eq(githubRepositories.orgId, orgId), eq(githubRepositories.id, dbId)))
					.limit(1),
			)
			const row = (rows[0] ?? null) as GithubRepositoryRow | null
			return row === null ? null : yield* decodeRow(row)
		})

		const findByOrgAndGithubRepoId = Effect.fn(
			"GithubRepositoryRepo.findByOrgAndGithubRepoId",
		)(function* (orgId: OrgId, githubRepoId: number) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(githubRepositories)
					.where(
						and(
							eq(githubRepositories.orgId, orgId),
							eq(githubRepositories.githubRepoId, githubRepoId),
						),
					)
					.limit(1),
			)
			const row = (rows[0] ?? null) as GithubRepositoryRow | null
			return row === null ? null : yield* decodeRow(row)
		})

		const findByOrgAndOwnerName = Effect.fn(
			"GithubRepositoryRepo.findByOrgAndOwnerName",
		)(function* (orgId: OrgId, owner: string, name: string) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(githubRepositories)
					.where(
						and(
							eq(githubRepositories.orgId, orgId),
							eq(githubRepositories.owner, owner),
							eq(githubRepositories.name, name),
						),
					)
					.limit(1),
			)
			const row = (rows[0] ?? null) as GithubRepositoryRow | null
			return row === null ? null : yield* decodeRow(row)
		})

		const listByOrgAndInstallation = Effect.fn(
			"GithubRepositoryRepo.listByOrgAndInstallation",
		)(function* (orgId: OrgId, installationDbId: string) {
			const rows = (yield* dbExecute((db) =>
				db
					.select()
					.from(githubRepositories)
					.where(
						and(
							eq(githubRepositories.orgId, orgId),
							eq(githubRepositories.installationId, installationDbId),
						),
					),
			)) as ReadonlyArray<GithubRepositoryRow>
			return yield* decodeRows(rows)
		})

		const listIdsByOrgAndInstallation = Effect.fn(
			"GithubRepositoryRepo.listIdsByOrgAndInstallation",
		)(function* (orgId: OrgId, installationDbId: string) {
			const rows = yield* dbExecute((db) =>
				db
					.select({ id: githubRepositories.id })
					.from(githubRepositories)
					.where(
						and(
							eq(githubRepositories.orgId, orgId),
							eq(githubRepositories.installationId, installationDbId),
						),
					),
			)
			return rows.map((r) => r.id)
		})

		const countByInstallationForOrg = Effect.fn(
			"GithubRepositoryRepo.countByInstallationForOrg",
		)(function* (orgId: OrgId) {
			const rows = yield* dbExecute((db) =>
				db
					.select({
						installationId: githubRepositories.installationId,
						count: sql<number>`count(*)`,
					})
					.from(githubRepositories)
					.where(eq(githubRepositories.orgId, orgId))
					.groupBy(githubRepositories.installationId),
			)
			return new Map(rows.map((c) => [c.installationId, Number(c.count)])) as ReadonlyMap<
				string,
				number
			>
		})

		const insert = Effect.fn("GithubRepositoryRepo.insert")(function* (
			row: GithubRepositoryInsert,
		) {
			yield* dbExecute((db) => db.insert(githubRepositories).values(row))
		})

		const updateById = Effect.fn("GithubRepositoryRepo.updateById")(function* (
			id: string,
			patch: Partial<GithubRepositoryInsert>,
		) {
			yield* dbExecute((db) =>
				db.update(githubRepositories).set(patch).where(eq(githubRepositories.id, id)),
			)
		})

		const deleteByOrgAndInstallation = Effect.fn(
			"GithubRepositoryRepo.deleteByOrgAndInstallation",
		)(function* (orgId: OrgId, installationDbId: string) {
			yield* dbExecute((db) =>
				db
					.delete(githubRepositories)
					.where(
						and(
							eq(githubRepositories.orgId, orgId),
							eq(githubRepositories.installationId, installationDbId),
						),
					),
			)
		})

		const findManyByIds = Effect.fn("GithubRepositoryRepo.findManyByIds")(function* (
			orgId: OrgId,
			ids: ReadonlyArray<string>,
		) {
			if (ids.length === 0) return [] as ReadonlyArray<DecodedGithubRepositoryRow>
			const rows = (yield* dbExecute((db) =>
				db
					.select()
					.from(githubRepositories)
					.where(
						and(eq(githubRepositories.orgId, orgId), inArray(githubRepositories.id, ids)),
					),
			)) as ReadonlyArray<GithubRepositoryRow>
			return yield* decodeRows(rows)
		})

		return {
			findByOrgAndDbId,
			findByOrgAndGithubRepoId,
			findByOrgAndOwnerName,
			listByOrgAndInstallation,
			listIdsByOrgAndInstallation,
			countByInstallationForOrg,
			insert,
			updateById,
			deleteByOrgAndInstallation,
			findManyByIds,
		} satisfies GithubRepositoryRepoShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
