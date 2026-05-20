import { Context, Effect, Layer, Schedule, Schema } from "effect"
import {
	encodeGithubSyncJob,
	type GithubSyncJob,
} from "@maple/domain/queues/github-jobs"
import { GithubSyncQueueBinding } from "./GithubSyncQueueBinding"


export interface GithubSyncQueueShape {
	readonly enqueue: (
		job: GithubSyncJob,
		options?: { delaySeconds?: number },
	) => Effect.Effect<void, GithubSyncQueueEnqueueError | Schema.SchemaError>
	readonly enqueueBatch: (
		jobs: ReadonlyArray<GithubSyncJob>,
	) => Effect.Effect<void, GithubSyncQueueEnqueueBatchError | Schema.SchemaError>
}

export class GithubSyncQueueEnqueueError extends Schema.TaggedErrorClass<GithubSyncQueueEnqueueError>()(
	"GithubSyncQueueEnqueueError",
	{ job: Schema.String, cause: Schema.Unknown }
) {}
export class GithubSyncQueueEnqueueBatchError extends Schema.TaggedErrorClass<GithubSyncQueueEnqueueBatchError>()(
	"GithubSyncQueueEnqueueBatchError",
	{ jobCount: Schema.Number, cause: Schema.Unknown }
) {}


export class GithubSyncQueue extends Context.Service<GithubSyncQueue, GithubSyncQueueShape>()(
	"GithubSyncQueue",
	{
		make: Effect.gen(function* () {
			const queueBinding = yield* GithubSyncQueueBinding

			const enqueue = Effect.fn("GithubSyncQueue.enqueue")(
				function* (job: GithubSyncJob, options?: { delaySeconds?: number }){
					// Let the error bubble up here - schema validation failures are real coding errors, 
					// no external dependency should cause this.
					const encoded = yield* encodeGithubSyncJob(job).pipe(
						Effect.tapError((e) => Effect.logError(`[GithubSyncQueue] failed to encode ${job._tag}`, e))
					)

					yield* Effect.tryPromise({
						try: () => queueBinding.send(
							encoded,
							options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined
						),
						catch: (error) => new GithubSyncQueueEnqueueError({ job: job._tag, cause: error })
					}).pipe(
						Effect.retry({
							schedule: Schedule.exponential("100 millis"),
							times: 3
						})
					)
				})

			const enqueueBatch = Effect.fn("GithubSyncQueue.enqueueBatch")(
				function* (jobs: ReadonlyArray<GithubSyncJob>){
					if (jobs.length === 0) return

					const encoded = yield* Effect.forEach(jobs, (j) => encodeGithubSyncJob(j)).pipe(
						Effect.tapError((e) => Effect.logError("[GithubSyncQueue] failed to encode batch", e))
					)

					yield* Effect.tryPromise({
						try: () => queueBinding.sendBatch(encoded.map(body => ({ body }))),
						catch: (error) => new GithubSyncQueueEnqueueBatchError({ jobCount: jobs.length, cause: error })
					}).pipe(
						Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 3})
					)
				})

			return {
				enqueue,
				enqueueBatch
			} satisfies GithubSyncQueueShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provideMerge(GithubSyncQueueBinding.layer)
	)
}
