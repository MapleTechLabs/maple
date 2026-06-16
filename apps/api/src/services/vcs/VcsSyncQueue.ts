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

// Cloudflare Queues transport limits, owned here (the only module that talks to
// the binding). Producers that must pre-size their payloads — e.g. a provider
// splitting a large push so each job fits — import these rather than hardcoding
// the platform's magic numbers.
export const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024 // max serialized message size
export const QUEUE_MAX_DELAY_SECONDS = 86_400 // max visibility delay (24h)

// Coerce a requested delay into the range Cloudflare accepts: a whole number of
// seconds in [0, 86_400]. Out-of-range/fractional values would otherwise make
// the binding reject the send/retry outright.
export const clampQueueDelaySeconds = (seconds: number): number =>
	Math.min(Math.max(0, Math.floor(seconds)), QUEUE_MAX_DELAY_SECONDS)

export interface VcsSyncQueueShape {
	/**
	 * Enqueue a job. `delaySeconds` (0–86,400) holds it invisible until the delay
	 * elapses — used to requeue a rate-limited backfill continuation only once the
	 * provider's budget is back.
	 */
	readonly send: (
		job: VcsSyncJob,
		options?: { readonly delaySeconds?: number },
	) => Effect.Effect<void, VcsQueueError>
	readonly sendBatch: (jobs: ReadonlyArray<VcsSyncJob>) => Effect.Effect<void, VcsQueueError>
}

export class VcsSyncQueue extends Context.Service<VcsSyncQueue, VcsSyncQueueShape>()(
	"@maple/api/services/vcs/VcsSyncQueue",
	{
		make: Effect.gen(function* () {
			const workerEnv = yield* WorkerEnvironment
			const queue = workerEnv[QUEUE_BINDING] as Queue<unknown> | undefined

			const send = Effect.fn("VcsSyncQueue.send")(function* (
				job: VcsSyncJob,
				options?: { readonly delaySeconds?: number },
			) {
				yield* Effect.annotateCurrentSpan({ "vcs.job.kind": job.kind, "vcs.provider": job.provider })
				if (!queue) {
					return yield* new VcsQueueError({ message: `Missing queue binding: ${QUEUE_BINDING}` })
				}
				const body = encodeJob(job)
				const sendOptions =
					options?.delaySeconds === undefined
						? undefined
						: { delaySeconds: clampQueueDelaySeconds(options.delaySeconds) }
				yield* Effect.tryPromise({
					try: () => queue.send(body, sendOptions),
					catch: (cause) =>
						new VcsQueueError({
							message: cause instanceof Error ? cause.message : "queue send failed",
						}),
				})
			})

			const sendBatch = Effect.fn("VcsSyncQueue.sendBatch")(function* (
				jobs: ReadonlyArray<VcsSyncJob>,
			) {
				// Count + distinct kinds only — a fixed, low-cardinality summary. A batch can
				// hold hundreds of jobs, so a raw kind-per-job list would be unbounded and
				// redundant with the count.
				yield* Effect.annotateCurrentSpan({
					"vcs.jobs.length": jobs.length,
					"vcs.job.kinds": [...new Set(jobs.map((j) => j.kind))].sort().join(","),
				})
				if (jobs.length === 0) return
				if (!queue) {
					return yield* new VcsQueueError({ message: `Missing queue binding: ${QUEUE_BINDING}` })
				}
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
