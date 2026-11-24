import {
	isInstallationProcessable,
	type VcsQueueError,
	type VcsRepoDecodeError,
	type VcsRepoPersistenceError,
	type VcsSyncJob,
} from "@maple/domain/http"
import { githubAuditCategoryEnabled } from "@maple/domain/github-audit"
import { Context, Effect, Layer, Array as Arr } from "effect"
import { VcsRepository } from "./VcsRepository"
import { VcsSyncQueue } from "./VcsSyncQueue"

// Vendor-agnostic producer for the periodic (cron) VCS sync. Once every 12h it
// enqueues one `installation-sync` job (reason "scheduled") per processable
// installation across every org. All provider work — re-listing repos,
// refreshing branches, backfilling each tracked branch's commits — happens in
// the queue consumer (VcsSyncService) behind the VcsProviderClient port, so this
// scheduler never touches a provider module. It is the backstop for any webhook
// delivery (push, branch, installation) that was dropped.

interface VcsScheduledSyncResult {
	/** Installations found across all orgs, regardless of status. */
	readonly installationsTotal: number
	/** Jobs enqueued (one per processable installation). */
	readonly enqueued: number
	/** Installations skipped because they are not processable (suspended/disconnected). */
	readonly skipped: number
}

export interface VcsScheduledSyncServiceApi {
	readonly runScheduledSync: Effect.Effect<
		VcsScheduledSyncResult,
		VcsRepoPersistenceError | VcsRepoDecodeError | VcsQueueError
	>
	/**
	 * Every 15 minutes: one `rule-suite-scan` job per GitHub installation that collects refused
	 * pushes. Returns how many it enqueued.
	 */
	readonly runRuleSuiteScan: Effect.Effect<
		number,
		VcsRepoPersistenceError | VcsRepoDecodeError | VcsQueueError
	>
}

export class VcsScheduledSyncService extends Context.Service<
	VcsScheduledSyncService,
	VcsScheduledSyncServiceApi
>()("@maple/backend/services/vcs/VcsScheduledSyncService", {
	make: Effect.gen(function* () {
		const repo = yield* VcsRepository
		const queue = yield* VcsSyncQueue

		const runScheduledSync = Effect.gen(function* () {
			const installations = yield* repo.listAllInstallations()
			// Filter here so we don't enqueue no-op work; the consumer would skip
			// suspended/disconnected installations anyway.
			const processable = Arr.filter(installations, isInstallationProcessable)

			const jobs = Arr.map(processable, (installation): VcsSyncJob => ({
				kind: "installation-sync",
				provider: installation.provider,
				externalInstallationId: installation.externalInstallationId,
				reason: "scheduled",
			}))
			// `sendBatch` handles chunking to platform per-call caps internally.
			yield* queue.sendBatch(jobs)

			const result: VcsScheduledSyncResult = {
				installationsTotal: installations.length,
				enqueued: jobs.length,
				skipped: installations.length - jobs.length,
			}
			yield* Effect.annotateCurrentSpan({
				"vcs.scheduled.installations_total": result.installationsTotal,
				"vcs.scheduled.enqueued": result.enqueued,
				"vcs.scheduled.skipped": result.skipped,
				"vcs.scheduled.outcome": "completed",
			})
			return result
		}).pipe(
			Effect.tapCause(() => Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "failed" })),
			Effect.withSpan("VcsScheduledSyncService.runScheduledSync"),
		)

		const runRuleSuiteScan = Effect.gen(function* () {
			const installations = yield* repo.listAllInstallations()
			const jobs = Arr.map(
				Arr.filter(
					installations,
					(installation) =>
						installation.provider === "github" &&
						isInstallationProcessable(installation) &&
						installation.auditLogEnabled &&
						githubAuditCategoryEnabled(installation.auditCategories, "refusedPushes"),
				),
				(installation): VcsSyncJob => ({
					kind: "rule-suite-scan",
					provider: installation.provider,
					externalInstallationId: installation.externalInstallationId,
				}),
			)
			yield* queue.sendBatch(jobs)
			yield* Effect.annotateCurrentSpan({
				"vcs.rule_suites.installations_total": installations.length,
				"vcs.rule_suites.enqueued": jobs.length,
			})
			return jobs.length
		}).pipe(Effect.withSpan("VcsScheduledSyncService.runRuleSuiteScan"))

		return { runScheduledSync, runRuleSuiteScan } satisfies VcsScheduledSyncServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(VcsSyncQueue.layer, VcsRepository.layer)),
	)
}
