import {
	type BackfillRepoJob,
	type CommitUpsertInput,
	isInstallationProcessable,
	type UnknownVcsProviderError,
	type VcsInstallation,
	type VcsInstallationSyncReason,
	type VcsProviderError,
	type VcsQueueError,
	type VcsRateLimitedError,
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
// How many consecutive continuations may fetch zero commits (rate-limited before
// any progress) before we give up. Bounds a permanently throttled installation:
// a transient limit clears long before this, but a wedged one stops requeuing.
const MAX_BACKFILL_STALL_RETRIES = 10

const decodeJob = Schema.decodeUnknownEffect(VcsSyncJob)

// VcsInstallationGoneError is handled internally (→ disconnect) and never
// surfaces here. VcsProviderError / VcsRepoUnavailableError that aren't caught
// propagate so the queue retries. VcsRateLimitedError propagates from a
// rate-limited fetchRepositories so the consumer redelivers after the delay
// (backfill handles its own rate limits via the resume cursor, not this error).
type SyncError =
	| VcsRepoPersistenceError
	| VcsRepoDecodeError
	| VcsProviderError
	| VcsRepoUnavailableError
	| VcsRateLimitedError
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
				job: BackfillRepoJob,
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const { commits, next } = yield* provider.fetchCommits(
						installation,
						{
							externalRepoId: job.externalRepoId,
							owner: job.owner,
							name: job.name,
							defaultBranch: job.defaultBranch,
						},
						{ sinceMs: job.sinceMs, ...(job.untilMs === undefined ? {} : { untilMs: job.untilMs }) },
					)
					yield* repo.upsertCommits(
						installation.orgId,
						installation.provider,
						job.externalRepoId,
						commits,
					)

					if (!next) {
						// Window fully walked → done.
						yield* repo.updateRepoSyncStatus(installation.orgId, installation.provider, job.externalRepoId, {
							status: "ready",
							error: null,
							syncedAt: now,
						})
						return
					}

					// No-progress guard: a resume run that fetched commits but didn't move
					// the watermark below the boundary (e.g. >100 commits sharing the exact
					// committer-second) would requeue itself forever. Stop and flag instead.
					if (job.untilMs !== undefined && commits.length > 0 && next.untilMs >= job.untilMs) {
						yield* repo.markRepoSyncError(
							installation.orgId,
							installation.provider,
							job.externalRepoId,
							"backfill stalled: commit-date watermark did not advance",
						)
						yield* Effect.logError("VCS backfill stalled — watermark did not advance").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								untilMs: job.untilMs,
							}),
						)
						return
					}

					// Stall guard: a run that fetched no commits made no progress (rate-limited
					// before page 1 / at the token mint). Count consecutive such runs and stop
					// once they exceed the cap, so a permanently throttled installation can't
					// requeue forever. Any productive run resets the counter.
					const staleAttempts = commits.length > 0 ? 0 : (job.staleAttempts ?? 0) + 1
					if (staleAttempts > MAX_BACKFILL_STALL_RETRIES) {
						yield* repo.markRepoSyncError(
							installation.orgId,
							installation.provider,
							job.externalRepoId,
							"backfill stalled: rate-limited before making progress",
						)
						yield* Effect.logError("VCS backfill stalled — rate-limited before any progress").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								staleAttempts,
							}),
						)
						return
					}

					// Cut short mid-walk → checkpoint status + requeue a continuation that
					// resumes from the watermark. Either the provider throttled us (wait
					// out `retryAfterSeconds`) or we hit the per-invocation page budget
					// (delay 0 → continue now); both bound each invocation's wall-clock
					// under the Queues 15-min limit. A fresh job (not a queue retry) keeps
					// the retry budget for genuine failures.
					yield* repo.updateRepoSyncStatus(installation.orgId, installation.provider, job.externalRepoId, {
						status: "backfilling",
						error: null,
						syncedAt: now,
					})
					yield* queue.send(
						{
							...job,
							untilMs: next.untilMs,
							staleAttempts,
						},
						{ delaySeconds: next.retryAfterSeconds },
					)
					yield* Effect.logInfo(
						next.reason === "page-budget"
							? "VCS backfill page budget reached — requeued continuation"
							: "VCS backfill rate-limited — requeued continuation",
					).pipe(
						Effect.annotateLogs({
							provider: installation.provider,
							externalRepoId: job.externalRepoId,
							untilMs: next.untilMs,
							reason: next.reason,
							delaySeconds: next.retryAfterSeconds,
							staleAttempts,
						}),
					)
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

			const applyPush = Effect.fn("VcsSyncService.applyPush")(function* (
				installation: VcsInstallation,
				job: { externalRepoId: string; commits: ReadonlyArray<CommitUpsertInput> },
			) {
					// A push is incremental enrichment only: upsert the pushed commits and
					// deliberately leave the repo's sync state untouched. A push may target
					// any branch and its payload may be truncated, so it is never treated as
					// an authoritative sync — the default-branch backfill owns that.
					yield* repo.upsertCommits(
						installation.orgId,
						installation.provider,
						job.externalRepoId,
						job.commits,
					)
				})

			// THE gate: the single, vendor-agnostic answer to "should the sync engine
			// act on this installation's data?" (rule lives in isInstallationProcessable).
			// Every data-processing path runs through here; the decision is annotated on
			// the current span (`vcs.installation.processable`) so it's traceable, and a
			// skip is logged. Suspended / disconnected installations are skipped.
			const ensureProcessable = (installation: VcsInstallation, kind: VcsSyncJob["kind"]) =>
				Effect.gen(function* () {
					const processable = isInstallationProcessable(installation)
					yield* Effect.annotateCurrentSpan({
						"vcs.installation.status": installation.status,
						"vcs.installation.processable": processable,
					})
					if (!processable) {
						yield* Effect.logInfo("Skipping VCS job: installation not processable").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalInstallationId: installation.externalInstallationId,
								status: installation.status,
								kind,
							}),
						)
					}
					return processable
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

				// Status-transition events change the gate's answer for subsequent jobs
				// rather than processing data themselves — handled before any lookup.
				if (job.kind === "installation-sync") {
					if (job.reason === "suspend" || job.reason === "deleted") {
						const status = job.reason === "suspend" ? "suspended" : "disconnected"
						yield* repo.markInstallationStatus(job.provider, job.externalInstallationId, status)
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": status })
						return
					}
					if (job.reason === "unsuspend") {
						// The provider re-enabled the installation → restore it to active
						// before re-syncing, so the processability gate lets the sync proceed.
						yield* repo.markInstallationStatus(job.provider, job.externalInstallationId, "active")
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": "active" })
					}
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

				// The single agnostic gate — covers backfill, installation-sync, and push.
				if (!(yield* ensureProcessable(installation, job.kind))) return

				const provider = yield* registry.resolve(job.provider)

				const run = Match.value(job).pipe(
					Match.discriminator("kind")("backfill-repo", (job) => backfillRepo(provider, installation, job)),
					Match.discriminator("kind")("installation-sync", (job) => syncInstallation(provider, installation, job.reason)),
					Match.discriminator("kind")("push", (job) => applyPush(installation, job)),
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
