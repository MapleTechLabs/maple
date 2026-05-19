import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
	encodeGithubSyncJob,
	type GithubSyncJob,
} from "@maple/domain/queues/github-jobs"

type QueueBindingShape = {
	send: (body: unknown, options?: { delaySeconds?: number }) => Promise<void>
	sendBatch: (
		messages: Array<{ body: unknown; delaySeconds?: number }>,
	) => Promise<void>
}

const QUEUE_BINDING_NAME = "GITHUB_SYNC_QUEUE"

export interface GithubSyncQueueShape {
	readonly enqueue: (
		job: GithubSyncJob,
		options?: { delaySeconds?: number },
	) => Effect.Effect<void>
	readonly enqueueBatch: (
		jobs: ReadonlyArray<GithubSyncJob>,
	) => Effect.Effect<void>
	readonly isConfigured: Effect.Effect<boolean>
}

const isQueueBinding = (value: unknown): value is QueueBindingShape => {
	if (!value || typeof value !== "object") return false
	const obj = value as { send?: unknown; sendBatch?: unknown }
	return typeof obj.send === "function" && typeof obj.sendBatch === "function"
}

export class GithubSyncQueue extends Context.Service<GithubSyncQueue, GithubSyncQueueShape>()(
	"GithubSyncQueue",
	{
		make: Effect.gen(function* () {
			const env = yield* WorkerEnvironment
			const binding = env[QUEUE_BINDING_NAME]
			const queue = isQueueBinding(binding) ? binding : null

			const enqueue = (
				job: GithubSyncJob,
				options?: { delaySeconds?: number },
			): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (!queue) {
						yield* Effect.logWarning(
							`[GithubSyncQueue] No queue binding present; dropping job ${job._tag}`,
						)
						return
					}
					const encodedExit = yield* Effect.exit(encodeGithubSyncJob(job))
					if (encodedExit._tag === "Failure") {
						yield* Effect.logError(`[GithubSyncQueue] failed to encode ${job._tag}`)
						return
					}
					const sendExit = yield* Effect.exit(
						Effect.tryPromise({
							try: () =>
								queue.send(
									encodedExit.value,
									options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined,
								),
							catch: (cause) =>
								new Error(
									cause instanceof Error
										? `Failed to enqueue ${job._tag}: ${cause.message}`
										: `Failed to enqueue ${job._tag}`,
								),
						}),
					)
					if (sendExit._tag === "Failure") {
						yield* Effect.logWarning(
							`[GithubSyncQueue] queue.send failed (continuing): ${job._tag}`,
						)
					}
				})

			const enqueueBatch = (jobs: ReadonlyArray<GithubSyncJob>): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (jobs.length === 0) return
					if (!queue) {
						yield* Effect.logWarning(
							`[GithubSyncQueue] No queue binding present; dropping ${jobs.length} jobs`,
						)
						return
					}
					const encodedExit = yield* Effect.exit(
						Effect.forEach(jobs, (j) => encodeGithubSyncJob(j)),
					)
					if (encodedExit._tag === "Failure") {
						yield* Effect.logError("[GithubSyncQueue] failed to encode batch")
						return
					}
					const sendExit = yield* Effect.exit(
						Effect.tryPromise({
							try: () => queue.sendBatch(encodedExit.value.map((body) => ({ body }))),
							catch: (cause) =>
								new Error(
									cause instanceof Error
										? `Failed to enqueue batch: ${cause.message}`
										: "Failed to enqueue batch",
								),
						}),
					)
					if (sendExit._tag === "Failure") {
						yield* Effect.logWarning(
							`[GithubSyncQueue] queue.sendBatch failed (continuing); ${jobs.length} jobs lost`,
						)
					}
				})

			return {
				enqueue,
				enqueueBatch,
				isConfigured: Effect.succeed(queue !== null),
			} satisfies GithubSyncQueueShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Default = this.layer
}
