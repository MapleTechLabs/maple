import type { Queue } from "@cloudflare/workers-types"
import { VcsQueueError, VcsSyncJob } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { Context, Effect, Layer, Schema } from "effect"

// ---------------------------------------------------------------------------
// Vendor-agnostic queue producer. Reads the `VCS_SYNC_QUEUE` binding from the
// worker env and sends Schema-encoded `VcsSyncJob`s. The same queue carries
// jobs for every provider (discriminated by `job.provider`).
// ---------------------------------------------------------------------------

const QUEUE_BINDING = "VCS_SYNC_QUEUE"
const encodeJob = Schema.encodeSync(VcsSyncJob)

export interface VcsSyncQueueShape {
	readonly send: (job: VcsSyncJob) => Effect.Effect<void, VcsQueueError>
	readonly sendBatch: (jobs: ReadonlyArray<VcsSyncJob>) => Effect.Effect<void, VcsQueueError>
}

export class VcsSyncQueue extends Context.Service<VcsSyncQueue, VcsSyncQueueShape>()(
	"@maple/api/services/vcs/VcsSyncQueue",
	{
		make: Effect.gen(function* () {
			const workerEnv = yield* WorkerEnvironment
			const queue = (workerEnv as Record<string, unknown>)[QUEUE_BINDING] as Queue<unknown> | undefined

			const missing = new VcsQueueError({ message: `Missing queue binding: ${QUEUE_BINDING}` })

			const send = Effect.fn("VcsSyncQueue.send")(function* (job: VcsSyncJob) {
				if (!queue) return yield* missing
				const body = encodeJob(job)
				yield* Effect.tryPromise({
					try: () => queue.send(body),
					catch: (cause) =>
						new VcsQueueError({
							message: cause instanceof Error ? cause.message : "queue send failed",
						}),
				})
			})

			const sendBatch = Effect.fn("VcsSyncQueue.sendBatch")(function* (
				jobs: ReadonlyArray<VcsSyncJob>,
			) {
				if (jobs.length === 0) return
				if (!queue) return yield* missing
				const messages = jobs.map((job) => ({ body: encodeJob(job) }))
				yield* Effect.tryPromise({
					try: () => queue.sendBatch(messages),
					catch: (cause) =>
						new VcsQueueError({
							message: cause instanceof Error ? cause.message : "queue sendBatch failed",
						}),
				})
			})

			return { send, sendBatch } satisfies VcsSyncQueueShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
