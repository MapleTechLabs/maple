import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer, Option } from "effect"
import { type ObjectStore, ReplayBlobBucket } from "@/platform/bindings"
import { ReplayBlobStore, replayObjectKey } from "./ReplayBlobStore"

const gzip = (text: string): Effect.Effect<Uint8Array> =>
	Effect.promise(async () => {
		const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
		return new Uint8Array(await new Response(stream).arrayBuffer())
	})

/** Minimal stand-in for the bucket port. */
const fakeBucket = (objects: Record<string, Uint8Array>, onGet?: (key: string) => void): ObjectStore => ({
	getBytes: (key) =>
		Effect.sync(() => {
			onGet?.(key)
			return Option.fromNullishOr(objects[key])
		}),
})

const runWithBucket = <A>(
	bucket: ObjectStore,
	program: (store: typeof ReplayBlobStore.Service) => Effect.Effect<A>,
) =>
	Effect.gen(function* () {
		const store = yield* ReplayBlobStore
		return yield* program(store)
	}).pipe(
		Effect.provide(ReplayBlobStore.layer.pipe(Layer.provide(Layer.succeed(ReplayBlobBucket, bucket)))),
	)

describe("replayObjectKey", () => {
	// These expectations are duplicated verbatim in `replay_object_key`'s tests
	// in apps/ingest/src/r2.rs. Nothing at runtime reconciles the two — the
	// writer and the reader agree only by construction — and a divergence reads
	// to a user as "every recording is empty", not as an error. So both suites
	// pin the same strings.
	it("matches the ingest gateway's key scheme", () => {
		expect(replayObjectKey("org_123", "sess_abc", 7)).toBe("v1/org_123/sess_abc/00000007.json.gz")
	})

	it("zero-pads so lexicographic order is playback order", () => {
		const keys = [
			replayObjectKey("o", "s", 10),
			replayObjectKey("o", "s", 2),
			replayObjectKey("o", "s", 1),
		].sort()
		expect(keys).toEqual([
			"v1/o/s/00000001.json.gz",
			"v1/o/s/00000002.json.gz",
			"v1/o/s/00000010.json.gz",
		])
	})

	it("does not truncate a chunk seq wider than the pad", () => {
		expect(replayObjectKey("o", "s", 123_456_789)).toBe("v1/o/s/123456789.json.gz")
	})
})

describe("ReplayBlobStore.hydrate", () => {
	const events = '[{"type":2,"timestamp":1}]'

	it.live("fills in payloads for blob-backed chunks", () =>
		Effect.gen(function* () {
			const bucket = fakeBucket({
				"v1/org_1/sess_1/00000000.json.gz": yield* gzip(events),
			})
			const result = yield* runWithBucket(bucket, (store) =>
				store.hydrate("org_1", "sess_1", [{ chunkSeq: 0, events: "", byteSize: 26 }]),
			)
			expect(result).toEqual([{ chunkSeq: 0, events, byteSize: 26 }])
		}),
	)

	it.live("leaves pre-cutover chunks untouched and never fetches them", () =>
		Effect.gen(function* () {
			// The dual-read. A row written before the R2 cutover carries its payload
			// inline; going to the bucket for it would 404 and silently drop a chunk
			// that was there all along.
			const fetched: string[] = []
			const bucket = fakeBucket({}, (key) => fetched.push(key))
			const result = yield* runWithBucket(bucket, (store) =>
				store.hydrate("org_1", "sess_1", [{ chunkSeq: 0, events }]),
			)
			expect(result).toEqual([{ chunkSeq: 0, events }])
			expect(fetched).toEqual([])
		}),
	)

	it.live("drops a chunk whose object is missing rather than failing the request", () =>
		Effect.gen(function* () {
			const bucket = fakeBucket({
				"v1/org_1/sess_1/00000001.json.gz": yield* gzip(events),
			})
			const result = yield* runWithBucket(bucket, (store) =>
				store.hydrate("org_1", "sess_1", [
					{ chunkSeq: 0, events: "" },
					{ chunkSeq: 1, events: "" },
				]),
			)
			expect(result).toEqual([{ chunkSeq: 1, events }])
		}),
	)

	it.live("preserves chunk order despite concurrent fetches", () =>
		Effect.gen(function* () {
			const objects: Record<string, Uint8Array> = {}
			for (let seq = 0; seq < 20; seq++) {
				objects[replayObjectKey("org_1", "sess_1", seq)] = yield* gzip(`[${seq}]`)
			}
			const result = yield* runWithBucket(fakeBucket(objects), (store) =>
				store.hydrate(
					"org_1",
					"sess_1",
					Array.from({ length: 20 }, (_, seq) => ({ chunkSeq: seq, events: "" })),
				),
			)
			expect(result.map((chunk) => chunk.events)).toEqual(
				Array.from({ length: 20 }, (_, seq) => `[${seq}]`),
			)
		}),
	)

	it.live("is a no-op when the binding is absent", () =>
		Effect.gen(function* () {
			// Self-hosted and the Docker image of this API have no R2 at all. Every
			// row there carries its payload inline, so hydration must pass through
			// rather than erroring on a missing binding.
			const chunks = [{ chunkSeq: 0, events }]
			const result = yield* Effect.gen(function* () {
				const store = yield* ReplayBlobStore
				return yield* store.hydrate("org_1", "sess_1", chunks)
			}).pipe(Effect.provide(ReplayBlobStore.layer))
			expect(result).toEqual(chunks)
		}),
	)
})
