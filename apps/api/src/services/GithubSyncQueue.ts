import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { encodeGithubSyncJob, type GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { GithubSyncQueueBinding } from "./GithubSyncQueueBinding"
import { GithubSyncQueueEnqueueError } from "@maple/domain/http"

export interface GithubSyncQueueShape {
	readonly enqueue: (
		job: GithubSyncJob,
		options?: { delaySeconds?: number },
	) => Effect.Effect<void, GithubSyncQueueEnqueueError | Schema.SchemaError>
	readonly enqueueBatch: (
		jobs: ReadonlyArray<GithubSyncJob>,
	) => Effect.Effect<void, GithubSyncQueueEnqueueError | Schema.SchemaError>
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
				// Let the error bubble up here - schema validation failures are real coding errors,
				// no external dependency should cause this.
				const encoded = yield* encodeGithubSyncJob(job).pipe(
					Effect.tapError((e) =>
						Effect.logError(`[GithubSyncQueue] failed to encode ${job._tag}`, e),
					),
				)

				yield* Effect.tryPromise({
					try: () =>
						queueBinding.send(
							encoded,
							options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined,
						),
					catch: (error) =>
						new GithubSyncQueueEnqueueError({
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
				)

				yield* Effect.tryPromise({
					try: () => queueBinding.sendBatch(encoded.map((body) => ({ body }))),
					catch: (error) =>
						new GithubSyncQueueEnqueueError({
							message: `Failed to enqueue batch of ${jobs.length} jobs`,
							jobs: jobs.map((j) => j._tag),
							cause: error,
						}),
				}).pipe(Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 3 }))
			})

			return {
				enqueue,
				enqueueBatch,
			} satisfies GithubSyncQueueShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provideMerge(GithubSyncQueueBinding.layer),
	)
}
