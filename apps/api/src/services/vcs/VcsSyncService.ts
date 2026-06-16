import {
	type BranchEventJob,
	type InstallationSyncJob,
	isInstallationProcessable,
	type PushJob,
	type SyncBranchCommitsJob,
	type SyncBranchesJob,
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

// The historical window every branch commit-sync walks — each tracked branch is
// backfilled over the same span. Exported because the dashboard's "track a branch"
// flow (GithubConnectService) enqueues the same jobs.
export const BACKFILL_WINDOW_MS = 90 * 86_400_000 // 90 days
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

			// The repo's single tracked branch, with the default-branch fallback for a
			// row whose `trackedBranch` was never set (legacy) — the one place the
			// fallback rule lives.
			const trackedBranchOf = (repository: VcsRepo): string =>
				repository.trackedBranch ?? repository.defaultBranch

			// Build a commit-backfill job for a repo's branch over the standard window.
			const backfillJob = (
				installation: VcsInstallation,
				repository: VcsRepo,
				branch: string,
				sinceMs: number,
			): VcsSyncJob => ({
				kind: "sync-branch-commits",
				provider: installation.provider,
				externalInstallationId: installation.externalInstallationId,
				externalRepoId: repository.externalRepoId,
				owner: repository.owner,
				name: repository.name,
				branch,
				sinceMs,
			})

			// Point the repo at a new tracked branch: wipe its (old-branch) commits and
			// enqueue a fresh backfill of the new branch. Used by the engine's automatic
			// fallback to the default when the tracked branch is deleted upstream.
			const retargetTrackedBranch = (
				installation: VcsInstallation,
				repository: VcsRepo,
				newBranch: string,
			) =>
				Effect.gen(function* () {
					yield* repo.changeTrackedBranch(repository.orgId, repository.id, newBranch)
					const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
					yield* queue.send(backfillJob(installation, repository, newBranch, sinceMs))
					yield* Effect.logInfo("Tracked branch retargeted to default after deletion").pipe(
						Effect.annotateLogs({
							provider: installation.provider,
							externalRepoId: repository.externalRepoId,
							newBranch,
						}),
					)
				})

			const syncBranchCommits = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				repository: VcsRepo,
				job: SyncBranchCommitsJob,
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const { commits, next } = yield* provider.fetchCommits(
						installation,
						{
							externalRepoId: job.externalRepoId,
							owner: job.owner,
							name: job.name,
						},
						{
							sinceMs: job.sinceMs,
							branch: job.branch,
							...(job.untilMs === undefined ? {} : { untilMs: job.untilMs }),
						},
					)

					// Commits belong to the repo (no branch link), and the repo's commit set
					// is reset up front whenever the tracked branch changes — so a walk just
					// upserts. A force-push re-walk also only upserts: old (rebased-away) SHAs
					// stay for trace attribution.
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
						repo.markRepoSyncError(repository.id, error.message).pipe(
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
					Effect.withSpan("VcsSyncService.syncBranchCommits"),
				)

			const applyPush = Effect.fn("VcsSyncService.applyPush")(function* (
				installation: VcsInstallation,
				repository: VcsRepo,
				job: PushJob,
			) {
					// Surface the pushed branch in the picker even if it's not the tracked one
					// (so a user can switch to a freshly-pushed branch without waiting for the
					// next installation-sync). Commit ingestion is gated on the tracked branch.
					yield* repo.getOrCreateBranch(repository, job.branch)
					if (job.branch !== trackedBranchOf(repository)) return
					// The tracked branch was pushed. A normal push is best-effort enrichment:
					// upsert its commits onto the repo (the backfill remains authoritative).
					if (!job.forced) {
						yield* repo.upsertCommits(repository, job.commits)
						return
					}
					// A force-push rewrote history on the tracked branch. The push payload is
					// unreliable after a rewrite, so re-walk the branch instead — old SHAs stay
					// (kept for trace attribution), new commits are upserted.
					const now = yield* Clock.currentTimeMillis
					yield* queue.send(
						backfillJob(installation, repository, job.branch, now - BACKFILL_WINDOW_MS),
					)
				})

			// Re-list a repo's branches (the picker's list), reconcile deletions, then
			// enqueue a commit backfill for the repo's single tracked branch — refreshed
			// on every installation-sync. If the tracked branch itself vanished upstream,
			// fall back to the default (wipe + resync) instead. This handler deals in
			// branch *names* only; sync-branch-commits walks the commits.
			const syncBranches = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				repository: VcsRepo,
			) =>
				Effect.gen(function* () {
					const { branches, truncated } = yield* provider.fetchBranches(installation, {
						externalRepoId: repository.externalRepoId,
						owner: repository.owner,
						name: repository.name,
					})
					yield* repo.upsertBranches(repository, branches)
					const remoteNames = new Set(branches.map((b) => b.name))
					const deletedNames = yield* repo.reconcileBranchDeletions(repository.id, remoteNames, {
						truncated,
					})
					const tracked = trackedBranchOf(repository)
					// The tracked branch vanished (confirmed by a non-truncated re-list that
					// deleted it): retarget to the default and resync. Never when the tracked
					// branch IS the default — there's nothing better to fall back to.
					const trackedDeleted =
						deletedNames.includes(tracked) && tracked !== repository.defaultBranch
					yield* Effect.annotateCurrentSpan({
						"vcs.provider": installation.provider,
						"vcs.repository.external_id": repository.externalRepoId,
						"vcs.branches.listed": branches.length,
						"vcs.branches.truncated": truncated,
						"vcs.branches.tracked": tracked,
						"vcs.branches.tracked_deleted": trackedDeleted,
					})
					if (trackedDeleted) {
						yield* retargetTrackedBranch(installation, repository, repository.defaultBranch)
						return
					}
					const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
					yield* queue.send(backfillJob(installation, repository, tracked, sinceMs))
				}).pipe(
					// A repo-scoped fetch failure drains here (branch sync owns no sync_status —
					// that belongs to the commit backfill). Installation-gone propagates to the
					// disconnect handler in processMessage.
					Effect.catchTag("@maple/http/errors/VcsRepoUnavailableError", () =>
						Effect.logWarning("Repository unavailable — branch sync skipped").pipe(
							Effect.annotateLogs({
								provider: installation.provider,
								externalRepoId: repository.externalRepoId,
							}),
						),
					),
					Effect.withSpan("VcsSyncService.syncBranches"),
				)

			// A branch create/delete webhook: mutate the branch table directly (no provider
			// call). Creating a branch just surfaces it in the picker. Deleting one drops
			// its picker row; if it was the repo's tracked branch, fall back to the default
			// (wipe + resync) — unless the tracked branch IS the default, which GitHub
			// renames rather than deletes (the next installation-sync reconciles that).
			const applyBranchEvent = Effect.fn("VcsSyncService.applyBranchEvent")(function* (
				installation: VcsInstallation,
				repository: VcsRepo,
				job: BranchEventJob,
			) {
					if (job.action === "created") {
						yield* repo.getOrCreateBranch(repository, job.branch)
						return
					}
					const deleted = yield* repo.deleteBranch(repository.id, job.branch)
					if (
						deleted &&
						job.branch === trackedBranchOf(repository) &&
						job.branch !== repository.defaultBranch
					) {
						yield* retargetTrackedBranch(installation, repository, repository.defaultBranch)
					}
				})

			// THE gate: the single, vendor-agnostic answer to "should the sync engine
			// act on this installation's data?" (rule lives in isInstallationProcessable).
			// Every per-kind handler runs through here; the decision is annotated on the
			// current span (`vcs.installation.processable`) so it's traceable, and a skip
			// is logged. Suspended / disconnected installations are skipped.
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

			// Resolve the repo a data job targets (external repo id → entity), applying the
			// two drop rules every data job shares — logging + annotating each so the drop is
			// traceable. A `None` result means "drop this job":
			//  - unknown repo (no local row): nothing to attach to.
			//  - soft-removed repo: paused until access is re-granted (which flips it active).
			const resolveRepositoryForJob = (
				installation: VcsInstallation,
				job: PushJob | SyncBranchCommitsJob | SyncBranchesJob | BranchEventJob,
			) =>
				Effect.gen(function* () {
					const repositoryOpt = yield* repo.resolveRepository(
						installation.orgId,
						job.provider,
						job.externalRepoId,
					)
					if (Option.isNone(repositoryOpt)) {
						yield* Effect.logInfo("Dropping VCS job for unknown repository").pipe(
							Effect.annotateLogs({
								provider: job.provider,
								externalRepoId: job.externalRepoId,
								kind: job.kind,
							}),
						)
						return Option.none<VcsRepo>()
					}
					if (repositoryOpt.value.status === "removed") {
						yield* Effect.annotateCurrentSpan({ "vcs.repository.skipped": true })
						yield* Effect.logInfo("Skipping VCS job: repository removed").pipe(
							Effect.annotateLogs({
								provider: job.provider,
								externalRepoId: job.externalRepoId,
								kind: job.kind,
							}),
						)
						return Option.none<VcsRepo>()
					}
					return repositoryOpt
				})

			// ---- One handler per job kind ----------------------------------------
			// Each owns its own decision-making (the gate, repo resolution, and any
			// reason-specific branching); processMessage only resolves the installation
			// and dispatches by kind.

			const handleInstallationSync = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: InstallationSyncJob,
			) =>
				Effect.gen(function* () {
					// Status-transition reasons change the gate's answer for subsequent jobs
					// rather than processing data themselves.
					if (job.reason === "suspend" || job.reason === "deleted") {
						const status = job.reason === "suspend" ? "suspended" : "disconnected"
						yield* repo.markInstallationStatus(installation.id, status)
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": status })
						return
					}
					let active = installation
					if (job.reason === "unsuspend") {
						// The provider re-enabled the installation → restore it to active before
						// re-syncing so the gate lets the sync proceed. Reflect the new status on the
						// entity we already hold rather than re-reading it.
						yield* repo.markInstallationStatus(installation.id, "active")
						active = new VcsInstallation({ ...installation, status: "active", suspendedAt: null })
						yield* Effect.annotateCurrentSpan({ "vcs.installation.transition": "active" })
					}

					if (!(yield* ensureProcessable(active, job.kind))) return

					// A newly-created installation gives the org a clean single-installation
					// slate: hard-delete every *other* installation (and its repos/commits) for
					// the same org + provider. A user can remove the old GitHub installation on
					// GitHub's side without Maple ever receiving the `installation.deleted` webhook
					// (delivery isn't guaranteed), stranding a stale "active" row — which would
					// otherwise leave the org with several active installations, a state the
					// dashboard (one active installation per org) does not support. Purge (not just
					// suspend) so nothing lingers. Idempotent: a duplicate "created" — the GitHub
					// webhook and the dashboard callback each enqueue one — finds no siblings left.
					if (job.reason === "created") {
						const superseded = (yield* repo.listInstallationsByOrg(active.orgId)).filter(
							(other) => other.provider === active.provider && other.id !== active.id,
						)
						if (superseded.length > 0) {
							yield* Effect.forEach(superseded, (other) => repo.purgeInstallation(active.orgId, other.id), {
								discard: true,
							})
							yield* Effect.annotateCurrentSpan({
								"vcs.installation.superseded": superseded.length,
							})
							yield* Effect.logInfo("Purged superseded VCS installations after new install").pipe(
								Effect.annotateLogs({
									provider: active.provider,
									externalInstallationId: active.externalInstallationId,
									orgId: active.orgId,
									superseded: superseded.length,
								}),
							)
						}
					}

					const repos = yield* provider.fetchRepositories(installation)
					yield* repo.upsertRepositories(installation, repos)

					// Reconcile removals: soft-delete local repos no longer visible
					// upstream. The row and its synced commits are kept (a re-grant
					// reactivates via upsertRepositories); the "removed" status pauses
					// any further event processing for them. A user must explicitly
					// purge to drop the data.
					if (job.reason === "repositories_removed") {
						const remoteIds = new Set(repos.map((r) => r.externalRepoId))
						const local = yield* repo.listRepositoriesByInstallation(installation.id, "active")
						yield* Effect.forEach(
							local.filter((r) => !remoteIds.has(r.externalRepoId)),
							(r) => repo.markRepositoryRemoved(r.id),
							{ discard: true },
						)
					}

					// Per repo: sync its branch list (names only). The sync-branches handler
					// then enqueues the commit backfills for every tracked branch (the default
					// among them), so all commit-sync enqueuing lives in one place.
					yield* queue.sendBatch(
						repos.map((r): VcsSyncJob => ({
							kind: "sync-branches",
							provider: installation.provider,
							externalInstallationId: installation.externalInstallationId,
							externalRepoId: r.externalRepoId,
							owner: r.owner,
							name: r.name,
						})),
					)
				})

			const handleSyncBranchCommits = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: SyncBranchCommitsJob,
			) =>
				Effect.gen(function* () {
					if (!(yield* ensureProcessable(installation, job.kind))) return
					const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
					if (Option.isNone(repositoryOpt)) return
					yield* syncBranchCommits(provider, installation, repositoryOpt.value, job)
				})

			const handleSyncBranches = (
				provider: VcsProviderClient,
				installation: VcsInstallation,
				job: SyncBranchesJob,
			) =>
				Effect.gen(function* () {
					if (!(yield* ensureProcessable(installation, job.kind))) return
					const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
					if (Option.isNone(repositoryOpt)) return
					yield* syncBranches(provider, installation, repositoryOpt.value)
				})

			const handlePush = (installation: VcsInstallation, job: PushJob) =>
				Effect.gen(function* () {
					if (!(yield* ensureProcessable(installation, job.kind))) return
					const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
					if (Option.isNone(repositoryOpt)) return
					yield* applyPush(installation, repositoryOpt.value, job)
				})

			const handleBranchEvent = (installation: VcsInstallation, job: BranchEventJob) =>
				Effect.gen(function* () {
					if (!(yield* ensureProcessable(installation, job.kind))) return
					const repositoryOpt = yield* resolveRepositoryForJob(installation, job)
					if (Option.isNone(repositoryOpt)) return
					yield* applyBranchEvent(installation, repositoryOpt.value, job)
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
					"vcs.job.kind": job.kind,
					"vcs.installation.external_id": job.externalInstallationId,
				})

				// Resolve the installation once (external id → entity carrying our internal
				// id) — the single resolve for the whole job; every handler addresses the
				// installation by `installation.id`.
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
				const installation = installationOpt.value

				const provider = yield* registry.resolve(job.provider)

				// Dispatch by kind — each handler owns the gate, repo resolution, and all
				// decision-making for its job. No kind-specific branching lives here.
				const run = Match.value(job).pipe(
					Match.discriminator("kind")("installation-sync", (job) =>
						handleInstallationSync(provider, installation, job),
					),
					Match.discriminator("kind")("sync-branch-commits", (job) =>
						handleSyncBranchCommits(provider, installation, job),
					),
					Match.discriminator("kind")("sync-branches", (job) =>
						handleSyncBranches(provider, installation, job),
					),
					Match.discriminator("kind")("push", (job) => handlePush(installation, job)),
					Match.discriminator("kind")("branch-event", (job) => handleBranchEvent(installation, job)),
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
