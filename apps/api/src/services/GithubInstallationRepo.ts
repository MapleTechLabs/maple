import {
	githubInstallations,
	type GithubInstallationInsert,
	type GithubInstallationRow,
} from "@maple/db"
import {
	GithubAccountType,
	GithubPersistenceError,
	GithubRepositorySelection,
	type OrgId,
} from "@maple/domain/http"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"

export type DecodedGithubInstallationRow = Omit<
	GithubInstallationRow,
	"accountType" | "repositorySelection"
> & {
	readonly accountType: GithubAccountType
	readonly repositorySelection: GithubRepositorySelection
}

export interface GithubInstallationRepoShape {
	readonly countByOrg: (orgId: OrgId) => Effect.Effect<number, GithubPersistenceError>
	readonly listByOrg: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<DecodedGithubInstallationRow>, GithubPersistenceError>
	readonly listActive: () => Effect.Effect<
		ReadonlyArray<DecodedGithubInstallationRow>,
		GithubPersistenceError
	>
	readonly findByOrgAndDbId: (
		orgId: OrgId,
		dbId: string,
	) => Effect.Effect<DecodedGithubInstallationRow | null, GithubPersistenceError>
	readonly findByOrgAndInstallationId: (
		orgId: OrgId,
		installationId: number,
	) => Effect.Effect<DecodedGithubInstallationRow | null, GithubPersistenceError>
	readonly findByInstallationId: (
		installationId: number,
	) => Effect.Effect<ReadonlyArray<DecodedGithubInstallationRow>, GithubPersistenceError>
	readonly insert: (row: GithubInstallationInsert) => Effect.Effect<void, GithubPersistenceError>
	readonly updateById: (
		id: string,
		patch: Partial<GithubInstallationInsert>,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly updateSuspended: (
		orgId: OrgId,
		installationId: number,
		at: number,
	) => Effect.Effect<void, GithubPersistenceError>
	readonly deleteById: (id: string) => Effect.Effect<void, GithubPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new GithubPersistenceError({
		code: "Database",
		message: error instanceof Error ? error.message : "GitHub installation persistence failed",
	})

const decodeAccountType = Schema.decodeUnknownEffect(GithubAccountType)
const decodeRepositorySelection = Schema.decodeUnknownEffect(GithubRepositorySelection)

const decodeRow = (row: GithubInstallationRow) =>
	Effect.gen(function* () {
		const accountType = yield* decodeAccountType(row.accountType)
		const repositorySelection = yield* decodeRepositorySelection(row.repositorySelection)
		return {
			...row,
			accountType,
			repositorySelection,
		} satisfies DecodedGithubInstallationRow
	}).pipe(
		Effect.tapCause((cause) =>
			Effect.logError("Stored installation row failed enum decode", {
				"installation.id": row.id,
				"installation.installationId": row.installationId,
				cause,
			}),
		),
		Effect.mapError(
			() =>
				new GithubPersistenceError({
					code: "InstallationRowDecodeFailed",
					message: `Stored installation ${row.installationId} has invalid enum values`,
				}),
		),
	)

const decodeRows = (rows: ReadonlyArray<GithubInstallationRow>) =>
	Effect.forEach(rows, decodeRow)

export class GithubInstallationRepo extends Context.Service<
	GithubInstallationRepo,
	GithubInstallationRepoShape
>()("GithubInstallationRepo", {
	make: Effect.gen(function* () {
		const database = yield* Database

		// Wraps every DB call so the underlying DatabaseError stays in OTel via
		// the span's Cause (Effect.fn auto-tracing) while the wire shape is
		// always the typed GithubPersistenceError.
		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const countByOrg = Effect.fn("GithubInstallationRepo.countByOrg")(function* (orgId: OrgId) {
			const rows = yield* dbExecute((db) =>
				db
					.select({ count: sql<number>`count(*)` })
					.from(githubInstallations)
					.where(eq(githubInstallations.orgId, orgId)),
			)
			return Number(rows[0]?.count ?? 0)
		})

		const listByOrg = Effect.fn("GithubInstallationRepo.listByOrg")(function* (orgId: OrgId) {
			const rows = (yield* dbExecute((db) =>
				db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId)),
			)) as ReadonlyArray<GithubInstallationRow>
			return yield* decodeRows(rows)
		})

		const listActive = Effect.fn("GithubInstallationRepo.listActive")(function* () {
			const rows = (yield* dbExecute((db) =>
				db
					.select()
					.from(githubInstallations)
					.where(isNull(githubInstallations.suspendedAt)),
			)) as ReadonlyArray<GithubInstallationRow>
			return yield* decodeRows(rows)
		})

		const findByOrgAndDbId = Effect.fn("GithubInstallationRepo.findByOrgAndDbId")(function* (
			orgId: OrgId,
			dbId: string,
		) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(githubInstallations)
					.where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.id, dbId)))
					.limit(1),
			)
			const row = (rows[0] ?? null) as GithubInstallationRow | null
			return row === null ? null : yield* decodeRow(row)
		})

		const findByOrgAndInstallationId = Effect.fn(
			"GithubInstallationRepo.findByOrgAndInstallationId",
		)(function* (orgId: OrgId, installationId: number) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(githubInstallations)
					.where(
						and(
							eq(githubInstallations.orgId, orgId),
							eq(githubInstallations.installationId, installationId),
						),
					)
					.limit(1),
			)
			const row = (rows[0] ?? null) as GithubInstallationRow | null
			return row === null ? null : yield* decodeRow(row)
		})

		const findByInstallationId = Effect.fn("GithubInstallationRepo.findByInstallationId")(
			function* (installationId: number) {
				const rows = (yield* dbExecute((db) =>
					db
						.select()
						.from(githubInstallations)
						.where(eq(githubInstallations.installationId, installationId)),
				)) as ReadonlyArray<GithubInstallationRow>
				return yield* decodeRows(rows)
			},
		)

		const insert = Effect.fn("GithubInstallationRepo.insert")(function* (
			row: GithubInstallationInsert,
		) {
			yield* dbExecute((db) => db.insert(githubInstallations).values(row))
		})

		const updateById = Effect.fn("GithubInstallationRepo.updateById")(function* (
			id: string,
			patch: Partial<GithubInstallationInsert>,
		) {
			yield* dbExecute((db) =>
				db.update(githubInstallations).set(patch).where(eq(githubInstallations.id, id)),
			)
		})

		const updateSuspended = Effect.fn("GithubInstallationRepo.updateSuspended")(function* (
			orgId: OrgId,
			installationId: number,
			at: number,
		) {
			yield* dbExecute((db) =>
				db
					.update(githubInstallations)
					.set({ suspendedAt: at, updatedAt: at })
					.where(
						and(
							eq(githubInstallations.orgId, orgId),
							eq(githubInstallations.installationId, installationId),
						),
					),
			)
		})

		const deleteById = Effect.fn("GithubInstallationRepo.deleteById")(function* (id: string) {
			yield* dbExecute((db) =>
				db.delete(githubInstallations).where(eq(githubInstallations.id, id)),
			)
		})

		return {
			countByOrg,
			listByOrg,
			listActive,
			findByOrgAndDbId,
			findByOrgAndInstallationId,
			findByInstallationId,
			insert,
			updateById,
			updateSuspended,
			deleteById,
		} satisfies GithubInstallationRepoShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
