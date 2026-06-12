import {
	type CommitUpsertInput,
	type UnknownVcsProviderError,
	type VcsInstallation,
	type VcsInstallationSyncReason,
	type VcsProviderError,
	type VcsQueueError,
	type VcsRepoDecodeError,
	type VcsRepoPersistenceError,
	VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Effect, Context, Layer, Option, Schema } from "effect"
import type { VcsProviderClient } from "./VcsProviderClient"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import { VcsSyncQueue } from "./VcsSyncQueue"

// ---------------------------------------------------------------------------
// Vendor-agnostic sync orchestrator. Decodes a queue message, resolves the
// owning installation (→ orgId + provider auth), then dispatches by job kind:
// fetch via the provider port → persist via the repo. The provider port is the
// only provider-specific surface it touches.
// ---------------------------------------------------------------------------

const BACKFILL_DAYS = 90
const DAY_MS = 86_400_000

const decodeJob = Schema.decodeUnknownEffect(VcsSyncJob)

type SyncError =
	| VcsRepoPersistenceError
	| VcsRepoDecodeError
	| VcsProviderError
	| VcsQueueError
	| UnknownVcsProviderError

export interface VcsSyncServiceShape {
	readonly processMessage: (raw: unknown) => Effect.Effect<void, SyncError>
}

export class VcsSyncService extends Context.Service<VcsSyncService, VcsSyncServiceShape>()(
	"@maple/api/services/vcs/VcsSyncService",
	{
		make: Effect.gen(function* () {
			const repo = yield* VcsRepository
			const registry = yield* VcsProviderRegistry
			const queue = yield* VcsSyncQueue

			const syncInstallation = Effect.fn("VcsSyncService.syncInstallation")(function* (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				reason: VcsInstallationSyncReason,
			) {
					const now = yield* Clock.currentTimeMillis
					const repos = yield* provider.fetchRepositories(installation)
					yield* repo.upsertRepositories(
						installation.orgId,
						installation.provider,
						installation.externalInstallationId,
						repos,
					)

					// Reconcile removals: drop local repos no longer visible upstream.
					if (reason === "repositories_removed") {
						const remoteIds = new Set(repos.map((r) => r.externalRepoId))
						const local = yield* repo.listRepositoriesByInstallation(
							installation.provider,
							installation.externalInstallationId,
						)
						yield* Effect.forEach(
							local.filter((r) => !remoteIds.has(r.externalRepoId)),
							(r) =>
								repo.removeRepository(installation.orgId, installation.provider, r.externalRepoId),
							{ discard: true },
						)
					}

					const sinceMs = now - BACKFILL_DAYS * DAY_MS
					yield* queue.sendBatch(
						repos.map((r) => ({
							kind: "backfill-repo" as const,
							provider: installation.provider,
							externalInstallationId: installation.externalInstallationId,
							externalRepoId: r.externalRepoId,
							owner: r.owner,
							name: r.name,
							defaultBranch: r.defaultBranch,
							sinceMs,
						})),
					)
			})

			const backfillRepo = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: { externalRepoId: string; owner: string; name: string; defaultBranch: string; sinceMs: number },
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const commits = yield* provider.fetchCommits(
						installation,
						{
							externalRepoId: job.externalRepoId,
							owner: job.owner,
							name: job.name,
							defaultBranch: job.defaultBranch,
						},
						{ sinceMs: job.sinceMs },
					)
					yield* repo.upsertCommits(
						installation.orgId,
						installation.provider,
						job.externalRepoId,
						commits,
					)
					// GitHub returns newest-first; the first commit is the branch head.
					yield* repo.updateRepoSyncCursor(installation.orgId, installation.provider, job.externalRepoId, {
						status: "ready",
						cursorSha: commits[0]?.sha ?? null,
						error: null,
						syncedAt: now,
					})
				}).pipe(
					// App uninstalled / repo gone → stop retrying, mark the installation disconnected.
					Effect.catchTag(
						"@maple/http/errors/VcsProviderError",
						(error): Effect.Effect<void, VcsProviderError | VcsRepoPersistenceError> =>
							error.status === 404 || error.status === 410
								? repo
										.markInstallationStatus(
											installation.provider,
											installation.externalInstallationId,
											"disconnected",
										)
										.pipe(
											Effect.flatMap(() =>
												Effect.logWarning("VCS installation no longer accessible").pipe(
													Effect.annotateLogs({
														provider: installation.provider,
														externalInstallationId: installation.externalInstallationId,
														status: error.status,
													}),
												),
											),
										)
								: Effect.fail(error),
					),
					Effect.withSpan("VcsSyncService.backfillRepo"),
				)

			const applyPushDelta = Effect.fn("VcsSyncService.applyPushDelta")(function* (
				installation: VcsInstallation,
				job: { externalRepoId: string; commits: ReadonlyArray<CommitUpsertInput> },
			) {
					const now = yield* Clock.currentTimeMillis
					yield* repo.upsertCommits(
						installation.orgId,
						installation.provider,
						job.externalRepoId,
						job.commits,
					)
					// Push commits are oldest→newest; the last is the new branch head.
					const head = job.commits.length > 0 ? job.commits[job.commits.length - 1] : undefined
					yield* repo.updateRepoSyncCursor(installation.orgId, installation.provider, job.externalRepoId, {
						status: "ready",
						cursorSha: head?.sha ?? null,
						error: null,
						syncedAt: now,
					})
				})

			const processMessage = Effect.fn("VcsSyncService.processMessage")(function* (raw: unknown) {
				const jobOpt = yield* decodeJob(raw).pipe(
					Effect.map(Option.some),
					Effect.catch((cause) =>
						Effect.logWarning("Dropping undecodable VCS sync job").pipe(
							Effect.annotateLogs({ error: String(cause) }),
							Effect.as(Option.none<VcsSyncJob>()),
						),
					),
				)
				if (Option.isNone(jobOpt)) return
				const job = jobOpt.value
				yield* Effect.annotateCurrentSpan({
					"vcs.provider": job.provider,
					"vcs.job_kind": job.kind,
					"vcs.installation.external_id": job.externalInstallationId,
				})

				// suspend/delete only flip status — no installation lookup needed.
				if (
					job.kind === "installation-sync" &&
					(job.reason === "suspend" || job.reason === "deleted")
				) {
					yield* repo.markInstallationStatus(
						job.provider,
						job.externalInstallationId,
						job.reason === "suspend" ? "suspended" : "disconnected",
					)
					return
				}

				const installationOpt = yield* repo.getInstallation(job.provider, job.externalInstallationId)
				if (Option.isNone(installationOpt)) {
					yield* Effect.logInfo("Dropping VCS job for unknown installation").pipe(
						Effect.annotateLogs({
							provider: job.provider,
							externalInstallationId: job.externalInstallationId,
							kind: job.kind,
						}),
					)
					return
				}
				const installation = installationOpt.value
				if (installation.status === "disconnected") {
					yield* Effect.logInfo("Dropping VCS job for disconnected installation").pipe(
						Effect.annotateLogs({ externalInstallationId: job.externalInstallationId, kind: job.kind }),
					)
					return
				}

				const provider = yield* registry.resolve(job.provider)

				switch (job.kind) {
					case "installation-sync":
						return yield* syncInstallation(provider, installation, job.reason)
					case "backfill-repo":
						return yield* backfillRepo(provider, installation, job)
					case "push-delta":
						return yield* applyPushDelta(installation, job)
				}
			})

			return { processMessage } satisfies VcsSyncServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
