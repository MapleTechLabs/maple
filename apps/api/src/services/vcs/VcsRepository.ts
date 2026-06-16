import { randomUUID } from "node:crypto"
import {
	type CommitUpsertInput,
	GitCommitSha,
	type OrgId,
	type RepoUpsertInput,
	type UserId,
	VcsCommit,
	VcsInstallation,
	type VcsInstallationId,
	type VcsInstallStatus,
	type VcsProviderId,
	VcsRepo,
	type VcsRepoSelection,
	VcsRepoDecodeError,
	VcsRepoPersistenceError,
	type VcsAccountType,
	type VcsRepositoryId,
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
import { and, eq, inArray, sql } from "drizzle-orm"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "../../lib/DatabaseLive"

// D1 caps SQLite bind variables at ~100, so an `inArray(...)` over an unbounded
// id list (e.g. every repo of a large installation) must be chunked. Mirrors the
// same constant in the error/digest/anomaly services.
const D1_INARRAY_CHUNK_SIZE = 90

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
		installationId: row.installationId,
		externalRepoId: row.externalRepoId,
		owner: row.owner,
		name: row.name,
		fullName: row.fullName,
		defaultBranch: row.defaultBranch,
		htmlUrl: row.htmlUrl,
		isPrivate: row.isPrivate === 1,
		isArchived: row.isArchived === 1,
		status: row.status,
		syncStatus: row.syncStatus,
		lastSyncedAt: row.lastSyncedAt ?? null,
		lastSyncError: row.lastSyncError ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})

const rowToCommit = (row: VcsCommitRow): VcsCommit =>
	decodeCommit({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		repositoryId: row.repositoryId,
		sha: row.sha,
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

export interface RepoSyncStatusUpdate {
	readonly status: VcsRepoSyncStatus
	readonly error?: string | null
	readonly syncedAt?: number | null
}

/**
 * Read scope for repository queries — a required argument so every caller must
 * consciously decide whether provider-removed repos are in scope. `"active"`
 * returns only repos still visible to the installation; `"all"` includes those
 * whose access was removed (`status === "removed"`). Most business logic wants
 * `"active"`; the dashboard status (which surfaces the "re-enable / delete"
 * affordances) wants `"all"`.
 */
export type RepoQueryScope = "active" | "all"

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

		// THE external → internal resolver for installations: the one place a
		// provider's external installation id is turned into a Maple installation
		// (carrying our internal `id`). Every other installation method takes that
		// internal id; callers resolve once here and pass `installation.id` onward.
		// Returns the whole row, so there's never a resolve-then-refetch round-trip.
		const resolveInstallation = Effect.fn("VcsRepository.resolveInstallation")(function* (
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
			const rows = yield* database
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
						})
						.returning(),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// `.returning()` hands back the upserted row in the same statement — one
			// round-trip, and no read-after-write race with a concurrent status change.
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new VcsRepoPersistenceError({ message: "Installation upsert returned no row" })
			}
			return yield* decodeOne("vcs_installations", row.value, rowToInstallation)
		})

		const markInstallationStatus = Effect.fn("VcsRepository.markInstallationStatus")(function* (
			installationId: VcsInstallationId,
			status: VcsInstallStatus,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsInstallations)
						.set({ status, suspendedAt: status === "suspended" ? now : null, updatedAt: now })
						.where(eq(vcsInstallations.id, installationId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// ---- Repositories -------------------------------------------------

		const listRepositoriesByInstallation = Effect.fn("VcsRepository.listRepositoriesByInstallation")(
			function* (installationId: VcsInstallationId, scope: RepoQueryScope) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(vcsRepositories)
							.where(
								and(
									eq(vcsRepositories.installationId, installationId),
									// "all" includes provider-removed repos; "active" filters them out.
									...(scope === "active" ? [eq(vcsRepositories.status, "active")] : []),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return yield* decodeAll("vcs_repositories", rows, rowToRepo)
			},
		)

		// THE external → internal resolver for repositories: turns the provider's
		// external repo id (the only handle a webhook/queue job carries) into a
		// Maple repo (carrying our internal `id` and `installationId`). Returns the
		// whole row, so the sync path resolves once and passes the entity onward —
		// no resolve-then-refetch. Org-scoped so a tenant can't read another's repo.
		const resolveRepository = Effect.fn("VcsRepository.resolveRepository")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalRepoId: string,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.provider, provider),
								eq(vcsRepositories.externalRepoId, externalRepoId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsRepo>()
			return Option.some(yield* decodeOne("vcs_repositories", row.value, rowToRepo))
		})

		// Look up a repo by Maple's own id — the dashboard's handle. Org-scoped, so a
		// tenant can't read another's repo even with a guessed id (ids are globally
		// unique UUIDs, so the org filter is purely a safety bound).
		const getRepositoryById = Effect.fn("VcsRepository.getRepositoryById")(function* (
			orgId: OrgId,
			repositoryId: VcsRepositoryId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositories)
						.where(and(eq(vcsRepositories.orgId, orgId), eq(vcsRepositories.id, repositoryId)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsRepo>()
			return Option.some(yield* decodeOne("vcs_repositories", row.value, rowToRepo))
		})

		// Persist the installation's repositories. Takes the resolved installation
		// (not raw ids) so org/provider/internal-installation-id all come from one
		// entity — the rows link to it by our internal `installationId`.
		const upsertRepositories = Effect.fn("VcsRepository.upsertRepositories")(function* (
			installation: VcsInstallation,
			repos: ReadonlyArray<RepoUpsertInput>,
		) {
			if (repos.length === 0) return
			const now = yield* Clock.currentTimeMillis
			const values = repos.map((r) => ({
				id: randomUUID() as VcsRepo["id"],
				orgId: installation.orgId,
				provider: installation.provider,
				installationId: installation.id,
				externalRepoId: r.externalRepoId,
				owner: r.owner,
				name: r.name,
				fullName: r.fullName,
				defaultBranch: r.defaultBranch,
				htmlUrl: r.htmlUrl,
				isPrivate: r.isPrivate ? 1 : 0,
				isArchived: r.isArchived ? 1 : 0,
				// Every repo handed to upsert is one the installation can currently
				// see, so it is active. Set explicitly (not via column default) so the
				// conflict clause below can reactivate a previously-removed repo.
				status: "active" as const,
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
										// A repo can be reassigned to a different installation; refresh the link.
										installationId: sql`excluded.installation_id`,
										owner: sql`excluded.owner`,
										name: sql`excluded.name`,
										fullName: sql`excluded.full_name`,
										defaultBranch: sql`excluded.default_branch`,
										htmlUrl: sql`excluded.html_url`,
										isPrivate: sql`excluded.is_private`,
										isArchived: sql`excluded.is_archived`,
										// Reactivate on re-add: a repo present in this upsert is visible
										// again, so a prior "removed" soft-delete is cleared. (sync_status
										// is deliberately left untouched — its backfill state still holds.)
										status: sql`excluded.status`,
										updatedAt: sql`excluded.updated_at`,
									},
								}),
						)
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)
		})

		// Soft-delete: the provider revoked access to this repo. The row and its
		// synced commits are kept (so history survives and a re-grant reactivates
		// cleanly via upsertRepositories); `status` gates further event processing.
		const markRepositoryRemoved = Effect.fn("VcsRepository.markRepositoryRemoved")(function* (
			repositoryId: VcsRepositoryId,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({ status: "removed", updatedAt: now })
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Hard-delete a single repo and its commits by Maple's own repository id.
		// User-initiated only: the dashboard "delete from Maple" action. Confirm the
		// row exists for this org first (so a foreign/absent id is a no-op, not a
		// blind delete), then delete commits — which reference the repo by this id —
		// before the row, so a mid-failure can't orphan them. Idempotent.
		const purgeRepository = Effect.fn("VcsRepository.purgeRepository")(function* (
			orgId: OrgId,
			repositoryId: VcsRepositoryId,
		) {
			const repoRows = yield* database
				.execute((db) =>
					db
						.select({ id: vcsRepositories.id })
						.from(vcsRepositories)
						.where(and(eq(vcsRepositories.orgId, orgId), eq(vcsRepositories.id, repositoryId)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			if (repoRows[0]?.id === undefined) return false
			yield* database
				.execute((db) => db.delete(vcsCommits).where(eq(vcsCommits.repositoryId, repositoryId)))
				.pipe(Effect.mapError(toPersistenceError))
			yield* database
				.execute((db) => db.delete(vcsRepositories).where(eq(vcsRepositories.id, repositoryId)))
				.pipe(Effect.mapError(toPersistenceError))
			return true
		})

		const updateRepoSyncStatus = Effect.fn("VcsRepository.updateRepoSyncStatus")(function* (
			repositoryId: VcsRepositoryId,
			update: RepoSyncStatusUpdate,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({
							syncStatus: update.status,
							lastSyncError: update.error ?? null,
							lastSyncedAt: update.syncedAt ?? now,
							updatedAt: now,
						})
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Flag a single repo's sync as errored without touching its cursor /
		// last-synced time (a failed fetch must not wipe prior progress).
		const markRepoSyncError = Effect.fn("VcsRepository.markRepoSyncError")(function* (
			repositoryId: VcsRepositoryId,
			message: string,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({ syncStatus: "error", lastSyncError: message, updatedAt: now })
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// ---- Commits ------------------------------------------------------

		// Persist commits for an already-resolved repository. The orchestrator
		// resolves the repo via resolveRepository and only calls here when the row
		// exists (a push racing ahead of repo discovery is dropped upstream), so the
		// "unknown repo" case no longer lives at this layer. The commit row
		// denormalizes the repo's org/provider for the dashboard's (org_id, sha)
		// lookup, so both come straight off the entity.
		const upsertCommits = Effect.fn("VcsRepository.upsertCommits")(function* (
			repository: VcsRepo,
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
							orgId: repository.orgId,
							provider: repository.provider,
							repositoryId: repository.id,
							sha,
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
									target: [vcsCommits.repositoryId, vcsCommits.sha],
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

		// ---- Cascade delete -----------------------------------------------

		// Remove an installation and everything beneath it (its repositories and
		// their commits), in dependency order. The dashboard disconnect flow uses
		// this: severing the integration must not strand the org's repos/commits in
		// the VCS tables. Idempotent — re-running drops whatever still remains.
		//
		// Commits reference their repo by internal id, so the installation's repo
		// ids are resolved first and used to delete the commits; the repo and
		// installation rows are then deleted directly.
		const purgeInstallation = Effect.fn("VcsRepository.purgeInstallation")(function* (
			orgId: OrgId,
			installationId: VcsInstallationId,
		) {
			const repoRows = yield* database
				.execute((db) =>
					db
						.select({ id: vcsRepositories.id })
						.from(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.installationId, installationId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// 1. Commits for those repos (keyed by the globally-unique repository id),
			//    chunked under D1's bind-variable cap.
			yield* Effect.forEach(
				Arr.chunksOf(
					repoRows.map((r) => r.id),
					D1_INARRAY_CHUNK_SIZE,
				),
				(chunk) =>
					database
						.execute((db) => db.delete(vcsCommits).where(inArray(vcsCommits.repositoryId, chunk)))
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)

			// 2. The installation's repositories.
			yield* database
				.execute((db) =>
					db
						.delete(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.installationId, installationId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// 3. The installation row itself (id is globally unique; org-scoped as a safety bound).
			yield* database
				.execute((db) =>
					db
						.delete(vcsInstallations)
						.where(and(eq(vcsInstallations.orgId, orgId), eq(vcsInstallations.id, installationId))),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		return {
			resolveInstallation,
			listInstallationsByOrg,
			upsertInstallation,
			markInstallationStatus,
			listRepositoriesByInstallation,
			resolveRepository,
			getRepositoryById,
			upsertRepositories,
			markRepositoryRemoved,
			purgeRepository,
			updateRepoSyncStatus,
			markRepoSyncError,
			upsertCommits,
			findCommitBySha,
			purgeInstallation,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
