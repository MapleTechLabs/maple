import { assert, describe, it } from "@effect/vitest"
import { VcsQueueError, type VcsSyncJob } from "@maple/domain/http"
import {
	type QueueProducer,
	QueueSendError,
	VcsBackfillQueueProducer,
	VcsSyncQueueProducer,
} from "@maple/backend/platform/bindings"
import { Effect, Exit, Layer, Tracer, Schema, Array as Arr, String as Str } from "effect"
import {
	MESSAGING_SYSTEM,
	QUEUE_BATCH_MAX_BYTES,
	QUEUE_BATCH_MAX_MESSAGES,
	VCS_BACKFILL_QUEUE,
	VCS_SYNC_QUEUE,
	type VcsQueueName,
	VcsSyncQueue,
} from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { findError } from "./harness"

type CapturedMessage = { readonly body: unknown }

const kindOf = (body: unknown): string | undefined =>
	typeof body === "object" && body !== null && "kind" in body && typeof body.kind === "string"
		? body.kind
		: undefined

// Fake producers for both queues that capture each chunk passed to `sendBatch`, and which queue
// it went to. `reject` makes every call fail so the VcsQueueError path can be exercised.
const fakeQueueEnv = (opts?: { reject?: boolean }) => {
	const chunks: CapturedMessage[][] = []
	const sentTo: Array<{ readonly queue: VcsQueueName; readonly kinds: ReadonlyArray<string | undefined> }> =
		[]
	const producer = (queue: VcsQueueName): QueueProducer => ({
		sendBatch: (messages) =>
			opts?.reject
				? Effect.fail(new QueueSendError({ message: "simulated queue outage", cause: undefined }))
				: Effect.sync(() => {
						chunks.push([...messages])
						sentTo.push({ queue, kinds: Arr.map(messages, (m) => kindOf(m.body)) })
					}),
	})
	const layer = Layer.mergeAll(
		Layer.succeed(VcsSyncQueueProducer, producer(VCS_SYNC_QUEUE)),
		Layer.succeed(VcsBackfillQueueProducer, producer(VCS_BACKFILL_QUEUE)),
	)
	return { layer, chunks, sentTo }
}

const chunkSizes = (chunks: ReadonlyArray<ReadonlyArray<CapturedMessage>>): number[] =>
	Arr.map(chunks, (c) => c.length)

// Byte size of a captured message body, matching the producer's own measure.
const encoder = new TextEncoder()
const bodyBytes = (m: CapturedMessage): number => encoder.encode(JSON.stringify(m.body)).length

// Checks per-chunk limits rather than exact arrays so tests don't break if a
// fixture's encoded size shifts without the chunking logic changing.
const assertChunksValid = (chunks: ReadonlyArray<ReadonlyArray<CapturedMessage>>): void => {
	for (const chunk of chunks) {
		assert.ok(chunk.length >= 1, "no empty chunks are emitted")
		assert.ok(
			chunk.length <= QUEUE_BATCH_MAX_MESSAGES,
			`chunk holds ${chunk.length} <= ${QUEUE_BATCH_MAX_MESSAGES} messages`,
		)
		const bytes = Arr.reduce(chunk, 0, (sum, m) => sum + bodyBytes(m))
		if (chunk.length > 1) {
			assert.ok(
				bytes <= QUEUE_BATCH_MAX_BYTES,
				`multi-message chunk ${bytes} <= ${QUEUE_BATCH_MAX_BYTES} bytes`,
			)
		}
	}
}

const installSyncJob = (i: number): VcsSyncJob => ({
	kind: "installation-sync",
	provider: "github",
	externalInstallationId: String(i),
	reason: "scheduled",
})

// A push job whose single commit message is `messageBytes` long, so each encoded
// message size is controllable for the byte-bound chunk-split tests.
const pushJob = (i: number, messageBytes: number): VcsSyncJob => ({
	kind: "push",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: String(i),
	branch: "main",
	commits: [
		{
			sha: Str.repeat(40)("a"),
			message: Str.repeat(messageBytes)("x"),
			authorName: null,
			authorEmail: null,
			authorLogin: null,
			authorAvatarUrl: null,
			authoredAt: null,
			committedAt: 1,
			htmlUrl: `https://github.com/octo/repo/commit/${Str.repeat(40)("a")}`,
		},
	],
})

const provideQueue = (layer: Layer.Layer<VcsSyncQueueProducer | VcsBackfillQueueProducer>) =>
	Effect.provide(VcsSyncQueue.layer.pipe(Layer.provide(layer)))

/** Records every span so the producer span's kind and messaging attributes are assertable. */
const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

// Producer kind + messaging.system/destination are what put the queue on the
// service map as an external dependency; an Internal span with neither is
// invisible there. The consumer side (vcs-sync-runtime) mirrors these.
describe("VcsSyncQueue producer spans", () => {
	it.effect("sends emit Producer-kind spans with messaging semconv attributes", () => {
		const { layer } = fakeQueueEnv()
		return Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const queue = yield* VcsSyncQueue

			yield* queue.sendBatch([installSyncJob(1)]).pipe(Effect.withTracer(tracer))
			yield* queue.send(installSyncJob(2)).pipe(Effect.withTracer(tracer))

			const produced = Arr.filter(spans, (span) => Str.startsWith("VcsSyncQueue.")(span.name))
			assert.deepStrictEqual(Arr.map(produced, (span) => span.name).sort(), [
				"VcsSyncQueue.send",
				"VcsSyncQueue.sendBatch",
			])
			for (const span of produced) {
				assert.strictEqual(span.kind, "producer", `${span.name} is Producer-kind`)
				assert.strictEqual(span.attributes.get("messaging.system"), MESSAGING_SYSTEM)
				// A scheduled installation sync is a bulk refresh: it goes to the backfill queue.
				assert.strictEqual(span.attributes.get("messaging.destination.name"), VCS_BACKFILL_QUEUE)
				assert.strictEqual(span.attributes.get("messaging.operation.name"), "send")
			}
		}).pipe(provideQueue(layer))
	})
})

// The incident behind the split: a scheduled sync's fan-out held webhook jobs back for 15 minutes.
describe("VcsSyncQueue routing", () => {
	it.effect("keeps webhook deltas off the queue the bulk refreshes use", () => {
		const { layer, sentTo } = fakeQueueEnv()
		const connectSync: VcsSyncJob = { ...installSyncJob(9), reason: "created" }
		const scan: VcsSyncJob = {
			kind: "dependency-scan",
			provider: "github",
			externalInstallationId: "42",
			externalRepoId: "7",
			trigger: "schedule",
		}
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch([installSyncJob(1), pushJob(1, 10), scan, connectSync])
			yield* queue.send(scan)
			yield* queue.send(pushJob(2, 10))
			const kindsOn = (name: VcsQueueName) => {
				const sent = Arr.filter(sentTo, (s) => s.queue === name)
				return Arr.flatMap(sent, (s) => s.kinds)
			}
			assert.deepStrictEqual(kindsOn(VCS_SYNC_QUEUE), ["push", "installation-sync", "push"])
			assert.deepStrictEqual(kindsOn(VCS_BACKFILL_QUEUE), [
				"installation-sync",
				"dependency-scan",
				"dependency-scan",
			])
		}).pipe(provideQueue(layer))
	})
})

describe("VcsSyncQueue.sendBatch chunking", () => {
	it.effect("splits a list over the message-count cap into capped chunks", () => {
		const { layer, chunks } = fakeQueueEnv()
		const jobs = Array.from({ length: 230 }, (_, i) => installSyncJob(i))
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [
				QUEUE_BATCH_MAX_MESSAGES,
				QUEUE_BATCH_MAX_MESSAGES,
				30,
			])
			// No job is dropped: every chunk concatenated reconstructs the full list.
			assert.strictEqual(
				Arr.reduce(chunks, 0, (n, c) => n + c.length),
				jobs.length,
			)
		}).pipe(provideQueue(layer))
	})

	it.effect("splits on the cumulative byte cap, not just the count", () => {
		const { layer, chunks } = fakeQueueEnv()
		// 5 × ~100 KB jobs: 256 KB holds at most 2 per batch → [2, 2, 1].
		const jobs = Array.from({ length: 5 }, (_, i) => pushJob(i, 100_000))
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			// Sanity: a single job is under the byte cap (so the split is genuine).
			assert.ok(bodyBytes(chunks.flat()[0]!) < QUEUE_BATCH_MAX_BYTES)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [2, 2, 1])
		}).pipe(provideQueue(layer))
	})

	it.effect("emits a single oversized message as its own chunk rather than dropping it", () => {
		const { layer, chunks } = fakeQueueEnv()
		// One job larger than the whole batch byte cap, flanked by small jobs: the
		// big one must land alone, and neither neighbour may be lost.
		const big = pushJob(1, QUEUE_BATCH_MAX_BYTES + 10_000)
		const jobs = [installSyncJob(0), big, installSyncJob(2)]
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			assert.ok(
				Arr.some(chunks, (c) => c.length === 1 && bodyBytes(c[0]!) > QUEUE_BATCH_MAX_BYTES),
				"oversized message is sent in a chunk of its own",
			)
			// All three jobs survive across the chunks (nothing silently dropped).
			assert.strictEqual(
				Arr.reduce(chunks, 0, (n, c) => n + c.length),
				jobs.length,
			)
		}).pipe(provideQueue(layer))
	})

	it.effect("sends a small list in a single batch", () => {
		const { layer, chunks } = fakeQueueEnv()
		const jobs = [installSyncJob(1), installSyncJob(2)]
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [2])
		}).pipe(provideQueue(layer))
	})

	it.effect("an empty list sends nothing", () => {
		const { layer, chunks } = fakeQueueEnv()
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch([])
			assert.deepStrictEqual(chunks, [])
		}).pipe(provideQueue(layer))
	})
})

describe("VcsSyncQueue error paths", () => {
	it.effect("maps a queue.sendBatch rejection to VcsQueueError", () => {
		const { layer } = fakeQueueEnv({ reject: true })
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			const exit = yield* Effect.exit(queue.sendBatch([installSyncJob(1)]))
			assert.ok(Exit.isFailure(exit), "sendBatch surfaces the rejection")
			const error = findError(exit)
			assert.ok(Schema.is(VcsQueueError)(error))
			assert.match(error.message, /simulated queue outage/)
		}).pipe(provideQueue(layer))
	})
})
