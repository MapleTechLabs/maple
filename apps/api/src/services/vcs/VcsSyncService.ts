import {
	type BackfillRepoJob,
	type CommitUpsertInput,
	isInstallationProcessable,
	type UnknownVcsProviderError,
	VcsInstallation,
	type VcsInstallationSyncReason,
	type VcsProviderError,
	type VcsQueueError,
	type VcsRateLimitedError,
	type VcsRepo,
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
					yield* repo.upsertRepositories(installation, repos)

					// Reconcile removals: soft-delete local repos no longer visible
					// upstream. The row and its synced commits are kept (a re-grant
					// reactivates via upsertRepositories); the "removed" status pauses
					// any further event processing for them. A user must explicitly
					// purge to drop the data.
					if (reason === "repositories_removed") {
						const remoteIds = new Set(repos.map((r) => r.externalRepoId))
						const local = yield* repo.listRepositoriesByInstallation(installation.id, "active")
						yield* Effect.forEach(
							local.filter((r) => !remoteIds.has(r.externalRepoId)),
							(r) => repo.markRepositoryRemoved(r.id),
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
				repositoryOpt: Option.Option<VcsRepo>,
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

					// The repo row may have vanished between this job being enqueued and run
					// (a user "delete from Maple" racing the backfill). fetchCommits still ran
					// above — so an installation-gone signal can surface and disconnect — but
					// with no row to attach to, the fetched commits are dropped (exactly what
					// the old upsertCommits did for an unknown repo).
					if (Option.isNone(repositoryOpt)) {
						yield* Effect.logInfo("Skipping backfill for unknown repository").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: job.externalRepoId,
								count: commits.length,
							}),
						)
						return
					}
					const repository = repositoryOpt.value

					yield* repo.upsertCommits(repository, commits)

					if (!next) {
						// Window fully walked → done.
						yield* repo.updateRepoSyncStatus(repository.id, {
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
							repository.id,
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
							repository.id,
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
					yield* repo.updateRepoSyncStatus(repository.id, {
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
						Option.isNone(repositoryOpt)
							? Effect.logWarning("Repository unavailable — backfill skipped (no local row)").pipe(
									Effect.annotateLogs({
										provider: installation.provider,
										externalRepoId: job.externalRepoId,
									}),
								)
							: repo.markRepoSyncError(repositoryOpt.value.id, error.message).pipe(
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
				repository: VcsRepo,
				commits: ReadonlyArray<CommitUpsertInput>,
			) {
					// A push is incremental enrichment only: upsert the pushed commits and
					// deliberately leave the repo's sync state untouched. A push may target
					// any branch and its payload may be truncated, so it is never treated as
					// an authoritative sync — the default-branch backfill owns that.
					yield* repo.upsertCommits(repository, commits)
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

				// Resolve the installation once (external id → entity carrying our internal
				// id) — the single resolve for the whole job; every repo call below addresses
				// the installation by `installation.id`.
				const installationOpt = yield* repo.resolveInstallation(job.provider, job.externalInstallationId)
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
				let installation = installationOpt.value

				// Status-transition events change the gate's answer for subsequent jobs rather
				// than processing data themselves.
				if (job.kind === "installation-sync") {
					if (job.reason === "suspend" || job.reason === "deleted") {
						const status = job.reason === "suspend" ? "suspended" : "disconnected"
						yield* repo.markInstallationStatus(installation.id, status)
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": status })
						return
					}
					if (job.reason === "unsuspend") {
						// The provider re-enabled the installation → restore it to active before
						// re-syncing so the gate lets the sync proceed. Reflect the new status on the
						// entity we already hold rather than re-reading it.
						yield* repo.markInstallationStatus(installation.id, "active")
						installation = new VcsInstallation({ ...installation, status: "active", suspendedAt: null })
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": "active" })
					}
				}

				// The single agnostic gate — covers backfill, installation-sync, and push.
				if (!(yield* ensureProcessable(installation, job.kind))) return

				// A newly-created installation gives the org a clean single-installation
				// slate: hard-delete every *other* installation (and its repos/commits) for
				// the same org + provider. A user can remove the old GitHub installation on
				// GitHub's side without Maple ever receiving the `installation.deleted` webhook
				// (delivery isn't guaranteed), stranding a stale "active" row — which would
				// otherwise leave the org with several active installations, a state the
				// dashboard (one active installation per org) does not support. Purge (not just
				// suspend) so nothing lingers. Idempotent: a duplicate "created" — the GitHub
				// webhook and the dashboard callback each enqueue one — finds no siblings left.
				if (job.kind === "installation-sync" && job.reason === "created") {
					const superseded = (yield* repo.listInstallationsByOrg(installation.orgId)).filter(
						(other) => other.provider === installation.provider && other.id !== installation.id,
					)
					if (superseded.length > 0) {
						yield* Effect.forEach(
							superseded,
							(other) => repo.purgeInstallation(installation.orgId, other.id),
							{ discard: true },
						)
						yield* Effect.annotateCurrentSpan({
							"vcs.installation.superseded": superseded.length,
						})
						yield* Effect.logInfo("Purged superseded VCS installations after new install").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalInstallationId: installation.externalInstallationId,
								orgId: installation.orgId,
								superseded: superseded.length,
							}),
						)
					}
				}

				// Per-repo handling for data jobs: resolve the repo once (external repo id →
				// entity) and pass it down. A soft-removed repo is paused (its events are not
				// processed until access is re-granted). A push for an unknown repo is dropped
				// (best-effort enrichment — the backfill stores it once the repo exists); a
				// backfill for an unknown repo still runs (its fetch can surface an
				// installation-gone signal) but has nothing to persist to.
				let repositoryOpt: Option.Option<VcsRepo> = Option.none()
				if (job.kind === "push" || job.kind === "backfill-repo") {
					repositoryOpt = yield* repo.resolveRepository(installation.orgId, job.provider, job.externalRepoId)
					if (Option.isSome(repositoryOpt) && repositoryOpt.value.status === "removed") {
						yield* Effect.annotateCurrentSpan({ "vcs.repository.skipped": true })
						yield* Effect.logInfo("Skipping VCS job: repository removed").pipe(
							Effect.annotateLogs({
								provider: job.provider,
								externalRepoId: job.externalRepoId,
								kind: job.kind,
							}),
						)
						return
					}
					if (job.kind === "push" && Option.isNone(repositoryOpt)) {
						yield* Effect.logInfo("Dropping push for unknown repository").pipe(
							Effect.annotateLogs({ provider: job.provider, externalRepoId: job.externalRepoId }),
						)
						return
					}
				}

				const provider = yield* registry.resolve(job.provider)

				const run = Match.value(job).pipe(
					Match.discriminator("kind")("backfill-repo", (job) =>
						backfillRepo(provider, installation, repositoryOpt, job),
					),
					Match.discriminator("kind")("installation-sync", (job) =>
						syncInstallation(provider, installation, job.reason),
					),
					// repositoryOpt is guaranteed Some + active here (None/removed returned above).
					Match.discriminator("kind")("push", (job) =>
						Option.isSome(repositoryOpt) ? applyPush(repositoryOpt.value, job.commits) : Effect.void,
					),
					Match.exhaustive,
				)

				// The ONE place an installation is disconnected, and only on the provider's
				// authoritative gone signal — never on a raw HTTP status.
				return yield* run.pipe(
					Effect.catchTag("@maple/http/errors/VcsInstallationGoneError", () =>
						repo.markInstallationStatus(installation.id, "disconnected").pipe(
							Effect.flatMap(() =>
								Effect.logWarning("VCS installation reported gone by provider — marked disconnected").pipe(
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
