import {
	type CommitUpsertInput,
	type UnknownVcsProviderError,
	type VcsInstallation,
	type VcsInstallationSyncReason,
	type VcsProviderError,
	type VcsQueueError,
	type VcsRepoDecodeError,
	type VcsRepoPersistenceError,
	type VcsRepoUnavailableError,
	VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Effect, Context, Layer, Option, Schema, Match } from "effect"
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

// VcsInstallationGoneError is handled internally (→ disconnect) and never
// surfaces here. VcsProviderError / VcsRepoUnavailableError that aren't caught
// propagate so the queue retries.
type SyncError =
	| VcsRepoPersistenceError
	| VcsRepoDecodeError
	| VcsProviderError
	| VcsRepoUnavailableError
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
							kind: "backfill-repo",
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
					const { commits, headSha } = yield* provider.fetchCommits(
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
					// The provider supplies the head; the orchestrator never infers it.
					yield* repo.updateRepoSyncCursor(installation.orgId, installation.provider, job.externalRepoId, {
						status: "ready",
						cursorSha: headSha,
						error: null,
						syncedAt: now,
					})
				}).pipe(
					// The provider classifies failures; the orchestrator dispatches on the
					// semantic outcome, never on HTTP status:
					//  - VcsRepoUnavailableError (repo gone) → record on the repo and drain.
					//  - VcsInstallationGoneError → propagates to processMessage (disconnect).
					//  - VcsProviderError (transient) → propagates so the queue retries.
					Effect.catchTag("@maple/http/errors/VcsRepoUnavailableError", (error) =>
						repo
							.markRepoSyncError(
								installation.orgId,
								installation.provider,
								job.externalRepoId,
								error.message,
							)
							.pipe(
								Effect.flatMap(() =>
									Effect.logWarning("Repository unavailable — backfill skipped").pipe(
										Effect.annotateLogs({
											provider: installation.provider,
											externalRepoId: job.externalRepoId,
										}),
									),
								),
							),
					),
					Effect.withSpan("VcsSyncService.backfillRepo"),
				)

			const applyPushDelta = Effect.fn("VcsSyncService.applyPushDelta")(function* (
				installation: VcsInstallation,
				job: { externalRepoId: string; headSha: string; commits: ReadonlyArray<CommitUpsertInput> },
			) {
					const now = yield* Clock.currentTimeMillis
					yield* repo.upsertCommits(
						installation.orgId,
						installation.provider,
						job.externalRepoId,
						job.commits,
					)
					// The provider already told us the head (the push's `after`).
					yield* repo.updateRepoSyncCursor(installation.orgId, installation.provider, job.externalRepoId, {
						status: "ready",
						cursorSha: job.headSha,
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


				const run = Match.value(job).pipe(
					Match.discriminator("kind")("backfill-repo", (job) => backfillRepo(provider, installation, job)),
					Match.discriminator("kind")("installation-sync", (job) => syncInstallation(provider, installation, job.reason)),
					Match.discriminator("kind")("push-delta", (job) => applyPushDelta(installation, job)),
					Match.exhaustive
				)

				// The ONE place an installation is disconnected, and only on the
				// provider's authoritative gone signal — never on a raw HTTP status.
				return yield* run.pipe(
					Effect.catchTag("@maple/http/errors/VcsInstallationGoneError", () =>
						repo
							.markInstallationStatus(
								installation.provider,
								installation.externalInstallationId,
								"disconnected",
							)
							.pipe(
								Effect.flatMap(() =>
									Effect.logWarning(
										"VCS installation reported gone by provider — marked disconnected",
									).pipe(
										Effect.annotateLogs({
											provider: installation.provider,
											externalInstallationId: installation.externalInstallationId,
										}),
									),
								),
							),
					),
				)
			})

			return { processMessage } satisfies VcsSyncServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
