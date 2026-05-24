import { Clock, Context, Effect, Layer, Schedule } from "effect"
import { encodeGithubSyncJob, type GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { GithubSyncQueueEnqueueError, type OrgId } from "@maple/domain/http"
import { GithubSyncQueueBinding } from "./GithubSyncQueueBinding"

// How far back a backfill job seeds commit history. Matches the 90d trace TTL —
// commits older than this can't match an active span anyway. Older SHAs
// resolve on-demand via the unknown-sha job.
const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

export interface BackfillTarget {
	readonly orgId: OrgId
	readonly repoId: string
}

export interface GithubSyncQueueShape {
	readonly enqueue: (
		job: GithubSyncJob,
		options?: { delaySeconds?: number },
	) => Effect.Effect<void, GithubSyncQueueEnqueueError>
	readonly enqueueBatch: (
		jobs: ReadonlyArray<GithubSyncJob>,
	) => Effect.Effect<void, GithubSyncQueueEnqueueError>
	// Backfill helpers own the window math + BackfillRepo envelope shape so
	// callers don't have to know either. Single and batch variants because the
	// callback flow needs to enqueue all of an installation's repos in one go
	// while the per-repo handlers enqueue one at a time.
	readonly enqueueBackfill: (
		target: BackfillTarget,
	) => Effect.Effect<void, GithubSyncQueueEnqueueError>
	readonly enqueueBackfills: (
		targets: ReadonlyArray<BackfillTarget>,
	) => Effect.Effect<void, GithubSyncQueueEnqueueError>
}

export class GithubSyncQueue extends Context.Service<GithubSyncQueue, GithubSyncQueueShape>()(
	"GithubSyncQueue",
	{
		make: Effect.gen(function* () {
			const queueBinding = yield* GithubSyncQueueBinding

			const enqueue = Effect.fn("GithubSyncQueue.enqueue")(function* (
				job: GithubSyncJob,
				options?: { delaySeconds?: number },
			) {
				// Schema-encode failures are coding bugs (job shape drifted from the
				// codec), not runtime conditions a caller can recover from. Log and
				// promote to defect so they don't pollute the typed error channel.
				const encoded = yield* encodeGithubSyncJob(job).pipe(
					Effect.tapError((e) =>
						Effect.logError(`[GithubSyncQueue] failed to encode ${job._tag}`, e),
					),
					Effect.orDie,
				)

				yield* Effect.tryPromise({
					try: () =>
						queueBinding.send(
							encoded,
							options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined,
						),
					catch: (error) =>
						new GithubSyncQueueEnqueueError({
							code: "EnqueueFailed",
							message: `Failed to enqueue ${job._tag}`,
							jobs: [job._tag],
							cause: error,
						}),
				}).pipe(
					Effect.retry({
						schedule: Schedule.exponential("100 millis"),
						times: 3,
					}),
				)
			})

			const enqueueBatch = Effect.fn("GithubSyncQueue.enqueueBatch")(function* (
				jobs: ReadonlyArray<GithubSyncJob>,
			) {
				if (jobs.length === 0) return

				const encoded = yield* Effect.forEach(jobs, (j) => encodeGithubSyncJob(j)).pipe(
					Effect.tapError((e) => Effect.logError("[GithubSyncQueue] failed to encode batch", e)),
					Effect.orDie,
				)

				yield* Effect.tryPromise({
					try: () => queueBinding.sendBatch(encoded.map((body) => ({ body }))),
					catch: (error) =>
						new GithubSyncQueueEnqueueError({
							code: "EnqueueFailed",
							message: `Failed to enqueue batch of ${jobs.length} jobs`,
							jobs: jobs.map((j) => j._tag),
							cause: error,
						}),
				}).pipe(Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 3 }))
			})

			const enqueueBackfill = Effect.fn("GithubSyncQueue.enqueueBackfill")(function* (
				target: BackfillTarget,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* enqueue({
					_tag: "BackfillRepo",
					orgId: target.orgId,
					repoId: target.repoId,
					sinceUnixMs: now - BACKFILL_WINDOW_MS,
					cursor: null,
				})
			})

			const enqueueBackfills = Effect.fn("GithubSyncQueue.enqueueBackfills")(function* (
				targets: ReadonlyArray<BackfillTarget>,
			) {
				if (targets.length === 0) return
				const now = yield* Clock.currentTimeMillis
				const sinceUnixMs = now - BACKFILL_WINDOW_MS
				yield* enqueueBatch(
					targets.map((t) => ({
						_tag: "BackfillRepo" as const,
						orgId: t.orgId,
						repoId: t.repoId,
						sinceUnixMs,
						cursor: null,
					})),
				)
			})

			return {
				enqueue,
				enqueueBatch,
				enqueueBackfill,
				enqueueBackfills,
			} satisfies GithubSyncQueueShape
		}),
	},
) {
	// `bareLayer` leaves GithubSyncQueueBinding as a required dependency so
	// tests (or environments without a Cloudflare WorkerEnvironment) can
	// substitute `GithubSyncQueueBinding.layerNoop`.
	static readonly bareLayer = Layer.effect(this, this.make)
	static readonly layer = this.bareLayer.pipe(
		Layer.provideMerge(GithubSyncQueueBinding.layer),
	)
}
