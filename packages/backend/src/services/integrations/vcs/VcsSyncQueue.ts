import { VcsQueueError, VcsSyncJob } from "@maple/domain/http"
import { Context, Effect, Layer, Schema, Array as Arr } from "effect"
import { VcsBackfillQueueProducer, VcsSyncQueueProducer } from "@maple/backend/platform/bindings"

// Vendor-agnostic queue producer sending Schema-encoded `VcsSyncJob`s for every
// provider (discriminated by `job.provider`). Webhook deltas and bulk refreshes go
// to separate queues, so a scheduled sync's thousands of jobs never delay a webhook.

const encodeJob = Schema.encodeSync(VcsSyncJob)

/** The queues' logical ids: webhook deltas, and the bulk refreshes the cron and connects fan out. */
export const VCS_SYNC_QUEUE = "vcs-sync"
export const VCS_BACKFILL_QUEUE = "vcs-backfill"
export type VcsQueueName = typeof VCS_SYNC_QUEUE | typeof VCS_BACKFILL_QUEUE

const BACKFILL_KINDS: ReadonlySet<string> = new Set<VcsSyncJob["kind"]>([
	"sync-branches",
	"sync-commits",
	"dependency-scan",
])

/**
 * The queue a job (or its encoded body, on the consumer side) belongs to. A connect's or webhook's
 * `installation-sync` stays live: someone is waiting on its discovery. Anything unrecognised is live.
 */
export const vcsQueueFor = (job: unknown): VcsQueueName => {
	if (typeof job !== "object" || job === null || !("kind" in job) || typeof job.kind !== "string") {
		return VCS_SYNC_QUEUE
	}
	const scheduled = job.kind === "installation-sync" && "reason" in job && job.reason === "scheduled"
	return BACKFILL_KINDS.has(job.kind) || scheduled ? VCS_BACKFILL_QUEUE : VCS_SYNC_QUEUE
}

// Messaging semconv identity for these queues, shared with the consumer side
// (vcs-sync-runtime.ts) so producer and consumer spans agree. `messaging.system`
// has no registered value for Cloudflare Queues; the lowercase vendor name is
// what semconv prescribes for unregistered systems. Together with the Producer /
// Consumer span kinds these are what put the queue on the service map as an
// external dependency — an Internal span with neither is invisible there.
export const MESSAGING_SYSTEM = "cloudflare_queues"

// Cloudflare Queues transport limits, owned here (the only module that talks to
// the binding). Producers that must pre-size their payloads — e.g. a provider
// splitting a large push so each job fits — import these rather than hardcoding
// the platform's magic numbers.
export const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024 // max serialized message size
const QUEUE_MAX_DELAY_SECONDS = 86_400 // max visibility delay (24h)
// A single `sendBatch` call accepts at most 100 messages OR 256 KB of payload,
// whichever comes first. `sendBatch` packs jobs into chunks under BOTH bounds so
// callers can hand it an arbitrarily long list without pre-chunking.
export const QUEUE_BATCH_MAX_MESSAGES = 100
export const QUEUE_BATCH_MAX_BYTES = 256 * 1024

// Coerce a requested delay into the range Cloudflare accepts: a whole number of
// seconds in [0, 86_400]. Out-of-range/fractional values cause the binding to
// reject the send outright.
export const clampQueueDelaySeconds = (seconds: number): number =>
	Math.min(Math.max(0, Math.floor(seconds)), QUEUE_MAX_DELAY_SECONDS)

// Serialized byte size of a message body (UTF-8) — the basis for Cloudflare's per-batch byte cap.
const textEncoder = new TextEncoder()
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const jsonByteLength = (body: unknown): number => textEncoder.encode(encodeJson(body)).length

/** Greedy packing into `sendBatch` calls under both the message-count and byte caps. */
const packMessages = (
	sized: ReadonlyArray<{ readonly message: { body: unknown }; readonly size: number }>,
): Array<Array<{ body: unknown }>> => {
	const chunks: Array<Array<{ body: unknown }>> = []
	let current: Array<{ body: unknown }> = []
	let currentBytes = 0
	for (const { message, size } of sized) {
		const wouldOverflow =
			current.length >= QUEUE_BATCH_MAX_MESSAGES ||
			(current.length > 0 && currentBytes + size > QUEUE_BATCH_MAX_BYTES)
		if (wouldOverflow) {
			chunks.push(current)
			current = []
			currentBytes = 0
		}
		current.push(message)
		currentBytes += size
	}
	if (current.length > 0) chunks.push(current)
	return chunks
}

export interface VcsSyncQueueApi {
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

export class VcsSyncQueue extends Context.Service<VcsSyncQueue, VcsSyncQueueApi>()(
	"@maple/backend/services/vcs/VcsSyncQueue",
	{
		make: Effect.gen(function* () {
			const queues = {
				[VCS_SYNC_QUEUE]: yield* VcsSyncQueueProducer,
				[VCS_BACKFILL_QUEUE]: yield* VcsBackfillQueueProducer,
			}
			const toQueueError = (error: { readonly message: string }) =>
				new VcsQueueError({ message: error.message })

			const send = Effect.fn("VcsSyncQueue.send", {
				kind: "producer",
				attributes: { "messaging.system": MESSAGING_SYSTEM, "messaging.operation.name": "send" },
			})(function* (job: VcsSyncJob, options?: { readonly delaySeconds?: number }) {
				const destination = vcsQueueFor(job)
				yield* Effect.annotateCurrentSpan({
					"messaging.destination.name": destination,
					"vcs.job.kind": job.kind,
					"vcs.provider": job.provider,
				})
				const body = encodeJob(job)
				const delay =
					options?.delaySeconds === undefined
						? undefined
						: { delaySeconds: clampQueueDelaySeconds(options.delaySeconds) }
				yield* queues[destination].sendBatch([{ body, ...delay }]).pipe(Effect.mapError(toQueueError))
			})

			// One producer span per destination queue, so each lands on the service map as its own node.
			const sendBatchTo = Effect.fn("VcsSyncQueue.sendBatch", {
				kind: "producer",
				attributes: { "messaging.system": MESSAGING_SYSTEM, "messaging.operation.name": "send" },
			})(function* (destination: VcsQueueName, jobs: ReadonlyArray<VcsSyncJob>) {
				// Count + distinct kinds only — a fixed, low-cardinality summary. A batch can
				// hold hundreds of jobs, so a raw kind-per-job list would be unbounded and
				// redundant with the count.
				yield* Effect.annotateCurrentSpan({
					"messaging.destination.name": destination,
					"vcs.jobs.length": jobs.length,
					"vcs.job.kinds": Arr.join([...new Set(Arr.map(jobs, (j) => j.kind))].sort(), ","),
				})

				// Encode once, then greedily pack into chunks bounded by BOTH the message
				// count and the byte cap Cloudflare accepts per `sendBatch`. A single job
				// over the per-message cap is sent on its own (Cloudflare rejects it,
				// surfacing as VcsQueueError) rather than silently dropped.
				const sized = Arr.map(jobs, (job) => {
					const body = encodeJob(job)
					return { message: { body }, size: jsonByteLength(body) }
				})
				const chunks = packMessages(sized)

				yield* Effect.annotateCurrentSpan({ "vcs.jobs.batches": chunks.length })
				yield* Effect.forEach(
					chunks,
					(chunk) => queues[destination].sendBatch(chunk).pipe(Effect.mapError(toQueueError)),
					{ discard: true },
				)
			})

			const sendBatch = (jobs: ReadonlyArray<VcsSyncJob>) => {
				const live = Arr.filter(jobs, (job) => vcsQueueFor(job) === VCS_SYNC_QUEUE)
				const backfill = Arr.filter(jobs, (job) => vcsQueueFor(job) === VCS_BACKFILL_QUEUE)
				return Effect.forEach(
					[
						[VCS_SYNC_QUEUE, live],
						[VCS_BACKFILL_QUEUE, backfill],
					] as const,
					([destination, group]) =>
						group.length === 0 ? Effect.void : sendBatchTo(destination, group),
					{ discard: true },
				)
			}

			return { send, sendBatch } satisfies VcsSyncQueueApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
