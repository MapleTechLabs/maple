import { randomUUID } from "node:crypto"
import {
	type CommitUpsertInput,
	GitCommitSha,
	type OrgId,
	type RepoUpsertInput,
	type UserId,
	VcsCommit,
	VcsInstallation,
	type VcsInstallStatus,
	type VcsProviderId,
	VcsRepo,
	type VcsRepoSelection,
	VcsRepoDecodeError,
	VcsRepoPersistenceError,
	type VcsAccountType,
	type VcsRepoSyncStatus,
} from "@maple/domain/http"
import {
	chunkRowsForInsert,
	vcsCommits,
	vcsInstallations,
	type VcsCommitRow,
	type VcsInstallationRow,
	vcsRepositories,
	type VcsRepositoryRow,
} from "@maple/db"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "../../lib/DatabaseLive"

const decodeInstallation = Schema.decodeUnknownSync(VcsInstallation)
const decodeRepo = Schema.decodeUnknownSync(VcsRepo)
const decodeCommit = Schema.decodeUnknownSync(VcsCommit)
// Validate the SHA shape via the branded type (the regex lives only there);
// a malformed SHA throws and is caught into a VcsRepoDecodeError on write.
const decodeGitSha = Schema.decodeUnknownSync(GitCommitSha)

const toPersistenceError = (error: DatabaseError) => new VcsRepoPersistenceError({ message: error.message })

const decodeAll = <Row, A>(table: string, rows: ReadonlyArray<Row>, f: (row: Row) => A) =>
	Effect.try({
		try: () => rows.map(f),
		catch: (err) =>
			new VcsRepoDecodeError({ message: err instanceof Error ? err.message : "row decode failed", table }),
	})

const decodeOne = <Row, A>(table: string, row: Row, f: (row: Row) => A) =>
	Effect.try({
		try: () => f(row),
		catch: (err) =>
			new VcsRepoDecodeError({ message: err instanceof Error ? err.message : "row decode failed", table }),
	})

const rowToInstallation = (row: VcsInstallationRow): VcsInstallation =>
	decodeInstallation({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		externalInstallationId: row.externalInstallationId,
		accountLogin: row.accountLogin,
		accountType: row.accountType,
		externalAccountId: row.externalAccountId,
		accountAvatarUrl: row.accountAvatarUrl ?? null,
		repositorySelection: row.repositorySelection,
		status: row.status,
		suspendedAt: row.suspendedAt ?? null,
		installedByUserId: row.installedByUserId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})

const rowToRepo = (row: VcsRepositoryRow): VcsRepo =>
	decodeRepo({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		externalInstallationId: row.externalInstallationId,
		externalRepoId: row.externalRepoId,
		owner: row.owner,
		name: row.name,
		fullName: row.fullName,
		defaultBranch: row.defaultBranch,
		htmlUrl: row.htmlUrl,
		isPrivate: row.isPrivate === 1,
		isArchived: row.isArchived === 1,
		syncStatus: row.syncStatus,
		lastSyncedAt: row.lastSyncedAt ?? null,
		lastSyncCursor: row.lastSyncCursor ?? null,
		lastSyncError: row.lastSyncError ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})

const rowToCommit = (row: VcsCommitRow): VcsCommit =>
	decodeCommit({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		externalRepoId: row.externalRepoId,
		sha: row.sha,
		shortSha: row.shortSha,
		message: row.message,
		authorName: row.authorName ?? null,
		authorEmail: row.authorEmail ?? null,
		authorLogin: row.authorLogin ?? null,
		authorAvatarUrl: row.authorAvatarUrl ?? null,
		authoredAt: row.authoredAt ?? null,
		committedAt: row.committedAt,
		htmlUrl: row.htmlUrl,
		branch: row.branch ?? null,
		createdAt: row.createdAt,
	})

// Note: `status` is intentionally not part of the upsert input. A new row gets
// the schema column default ("active"); all status transitions (suspend /
// disconnect / unsuspend) go through `markInstallationStatus`, so a reconciling
// upsert never touches an existing installation's status.
export interface UpsertInstallationInput {
	readonly orgId: OrgId
	readonly provider: VcsProviderId
	readonly externalInstallationId: string
	readonly accountLogin: string
	readonly accountType: VcsAccountType
	readonly externalAccountId: string
	readonly accountAvatarUrl: string | null
	readonly repositorySelection: VcsRepoSelection
	readonly installedByUserId: UserId
}

export interface RepoSyncCursor {
	readonly status: VcsRepoSyncStatus
	readonly cursorSha?: string | null
	readonly error?: string | null
	readonly syncedAt?: number | null
}

export class VcsRepository extends Context.Service<VcsRepository>()("@maple/api/services/vcs/VcsRepository", {
	make: Effect.gen(function* () {
		const database = yield* Database

		// ---- Installations ------------------------------------------------

		const selectInstallationRow = (provider: VcsProviderId, externalInstallationId: string) =>
			database
				.execute((db) =>
					db
						.select()
						.from(vcsInstallations)
						.where(
							and(
								eq(vcsInstallations.provider, provider),
								eq(vcsInstallations.externalInstallationId, externalInstallationId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

		const getInstallation = Effect.fn("VcsRepository.getInstallation")(function* (
			provider: VcsProviderId,
			externalInstallationId: string,
		) {
			const rows = yield* selectInstallationRow(provider, externalInstallationId)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsInstallation>()
			return Option.some(yield* decodeOne("vcs_installations", row.value, rowToInstallation))
		})

		const listInstallationsByOrg = Effect.fn("VcsRepository.listInstallationsByOrg")(function* (orgId: OrgId) {
			const rows = yield* database
				.execute((db) => db.select().from(vcsInstallations).where(eq(vcsInstallations.orgId, orgId)))
				.pipe(Effect.mapError(toPersistenceError))
			return yield* decodeAll("vcs_installations", rows, rowToInstallation)
		})

		const upsertInstallation = Effect.fn("VcsRepository.upsertInstallation")(function* (
			input: UpsertInstallationInput,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.insert(vcsInstallations)
						// `status`/`suspended_at` are omitted: a new row takes the schema
						// default ("active"), and on conflict they are left untouched so a
						// reconcile can't un-suspend. Status is owned by markInstallationStatus.
						.values({
							id: randomUUID() as VcsInstallation["id"],
							orgId: input.orgId,
							provider: input.provider,
							externalInstallationId: input.externalInstallationId,
							accountLogin: input.accountLogin,
							accountType: input.accountType,
							externalAccountId: input.externalAccountId,
							accountAvatarUrl: input.accountAvatarUrl,
							repositorySelection: input.repositorySelection,
							installedByUserId: input.installedByUserId,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [vcsInstallations.provider, vcsInstallations.externalInstallationId],
							// Ownership columns (org_id, installed_by_user_id, created_at) and
							// status/suspended_at are immutable on conflict — only mutable
							// provider metadata is refreshed.
							set: {
								accountLogin: sql`excluded.account_login`,
								accountType: sql`excluded.account_type`,
								externalAccountId: sql`excluded.external_account_id`,
								accountAvatarUrl: sql`excluded.account_avatar_url`,
								repositorySelection: sql`excluded.repository_selection`,
								updatedAt: sql`excluded.updated_at`,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const rows = yield* selectInstallationRow(input.provider, input.externalInstallationId)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new VcsRepoPersistenceError({ message: "Installation vanished after upsert" })
			}
			return yield* decodeOne("vcs_installations", row.value, rowToInstallation)
		})

		const markInstallationStatus = Effect.fn("VcsRepository.markInstallationStatus")(function* (
			provider: VcsProviderId,
			externalInstallationId: string,
			status: VcsInstallStatus,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsInstallations)
						.set({ status, suspendedAt: status === "suspended" ? now : null, updatedAt: now })
						.where(
							and(
								eq(vcsInstallations.provider, provider),
								eq(vcsInstallations.externalInstallationId, externalInstallationId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// ---- Repositories -------------------------------------------------

		const listRepositoriesByInstallation = Effect.fn("VcsRepository.listRepositoriesByInstallation")(
			function* (provider: VcsProviderId, externalInstallationId: string) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(vcsRepositories)
							.where(
								and(
									eq(vcsRepositories.provider, provider),
									eq(vcsRepositories.externalInstallationId, externalInstallationId),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return yield* decodeAll("vcs_repositories", rows, rowToRepo)
			},
		)

		const upsertRepositories = Effect.fn("VcsRepository.upsertRepositories")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalInstallationId: string,
			repos: ReadonlyArray<RepoUpsertInput>,
		) {
			if (repos.length === 0) return
			const now = yield* Clock.currentTimeMillis
			const values = repos.map((r) => ({
				id: randomUUID() as VcsRepo["id"],
				orgId,
				provider,
				externalInstallationId,
				externalRepoId: r.externalRepoId,
				owner: r.owner,
				name: r.name,
				fullName: r.fullName,
				defaultBranch: r.defaultBranch,
				htmlUrl: r.htmlUrl,
				isPrivate: r.isPrivate ? 1 : 0,
				isArchived: r.isArchived ? 1 : 0,
				createdAt: now,
				updatedAt: now,
			}))
			yield* Effect.forEach(
				chunkRowsForInsert(vcsRepositories, values),
				(chunk) =>
					database
						.execute((db) =>
							db
								.insert(vcsRepositories)
								.values(chunk)
								.onConflictDoUpdate({
									target: [
										vcsRepositories.orgId,
										vcsRepositories.provider,
										vcsRepositories.externalRepoId,
									],
									set: {
										externalInstallationId: sql`excluded.external_installation_id`,
										owner: sql`excluded.owner`,
										name: sql`excluded.name`,
										fullName: sql`excluded.full_name`,
										defaultBranch: sql`excluded.default_branch`,
										htmlUrl: sql`excluded.html_url`,
										isPrivate: sql`excluded.is_private`,
										isArchived: sql`excluded.is_archived`,
										updatedAt: sql`excluded.updated_at`,
									},
								}),
						)
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)
		})

		const removeRepository = Effect.fn("VcsRepository.removeRepository")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalRepoId: string,
		) {
			yield* database
				.execute((db) =>
					db
						.delete(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.provider, provider),
								eq(vcsRepositories.externalRepoId, externalRepoId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const updateRepoSyncCursor = Effect.fn("VcsRepository.updateRepoSyncCursor")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalRepoId: string,
			cursor: RepoSyncCursor,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({
							syncStatus: cursor.status,
							lastSyncCursor: cursor.cursorSha ?? null,
							lastSyncError: cursor.error ?? null,
							lastSyncedAt: cursor.syncedAt ?? now,
							updatedAt: now,
						})
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.provider, provider),
								eq(vcsRepositories.externalRepoId, externalRepoId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// ---- Commits ------------------------------------------------------

		const upsertCommits = Effect.fn("VcsRepository.upsertCommits")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalRepoId: string,
			commits: ReadonlyArray<CommitUpsertInput>,
		) {
			if (commits.length === 0) return 0
			const now = yield* Clock.currentTimeMillis
			// Decode every SHA through the branded type before writing — a bad SHA
			// throws here and is mapped to VcsRepoDecodeError below.
			const values = yield* Effect.try({
				try: () =>
					commits.map((c) => {
						const sha = decodeGitSha(c.sha)
						return {
							id: randomUUID() as VcsCommit["id"],
							orgId,
							provider,
							externalRepoId,
							sha,
							shortSha: sha.slice(0, 7) as VcsCommit["shortSha"],
							message: c.message,
							authorName: c.authorName,
							authorEmail: c.authorEmail,
							authorLogin: c.authorLogin,
							authorAvatarUrl: c.authorAvatarUrl,
							authoredAt: c.authoredAt,
							committedAt: c.committedAt,
							htmlUrl: c.htmlUrl,
							branch: c.branch,
							createdAt: now,
						}
					}),
				catch: (err) =>
					new VcsRepoDecodeError({
						message: err instanceof Error ? err.message : "commit decode failed",
						table: "vcs_commits",
						column: "sha",
					}),
			})

			yield* Effect.forEach(
				chunkRowsForInsert(vcsCommits, values),
				(chunk) =>
					database
						.execute((db) =>
							db
								.insert(vcsCommits)
								.values(chunk)
								.onConflictDoUpdate({
									target: [
										vcsCommits.orgId,
										vcsCommits.provider,
										vcsCommits.externalRepoId,
										vcsCommits.sha,
									],
									set: {
										message: sql`excluded.message`,
										authorName: sql`excluded.author_name`,
										authorEmail: sql`excluded.author_email`,
										authorLogin: sql`excluded.author_login`,
										authorAvatarUrl: sql`excluded.author_avatar_url`,
										authoredAt: sql`excluded.authored_at`,
										committedAt: sql`excluded.committed_at`,
										htmlUrl: sql`excluded.html_url`,
										branch: sql`excluded.branch`,
									},
								}),
						)
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)
			return values.length
		})

		const findCommitBySha = Effect.fn("VcsRepository.findCommitBySha")(function* (
			orgId: OrgId,
			sha: GitCommitSha,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsCommits)
						.where(and(eq(vcsCommits.orgId, orgId), eq(vcsCommits.sha, sha)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsCommit>()
			return Option.some(yield* decodeOne("vcs_commits", row.value, rowToCommit))
		})

		return {
			getInstallation,
			listInstallationsByOrg,
			upsertInstallation,
			markInstallationStatus,
			listRepositoriesByInstallation,
			upsertRepositories,
			removeRepository,
			updateRepoSyncCursor,
			upsertCommits,
			findCommitBySha,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
