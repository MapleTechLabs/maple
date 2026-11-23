import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { Array as Arr, Effect, Fiber, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { liveQueryStream, releaseLiveQuery } from "./live-query"

describe("releaseLiveQuery", () => {
	test("cleans the collection up even when unsubscribing throws", async () => {
		const cleanups: Array<string> = []
		await Effect.runPromise(
			releaseLiveQuery({
				subscription: {
					unsubscribe: () => {
						throw new globalThis.Error("already unsubscribed")
					},
				},
				collection: {
					cleanup: () => {
						cleanups.push("collection")
						return Promise.resolve()
					},
				},
			}),
		)
		expect(cleanups).toEqual(["collection"])
	})
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("liveQueryStream", () => {
	test("a row loaded before the subscription disappears from the stream once deleted", async () => {
		const collection = createCollection(
			localOnlyCollectionOptions<{ id: string; name: string }>({
				getKey: (row) => row.id,
				initialData: [
					{ id: "a", name: "Platform" },
					{ id: "b", name: "Checkout" },
				],
			}),
		)
		const emitted: Array<ReadonlyArray<string>> = []
		const fiber = Effect.runFork(
			Stream.runForEach(
				liveQueryStream(
					(q) => q.from({ d: collection }),
					(rows) => Arr.map(rows, (row) => row.id),
				),
				(ids) => Effect.sync(() => emitted.push(ids)),
			),
		)
		await settle()
		collection.delete("a")
		await settle()
		await Effect.runPromise(Fiber.interrupt(fiber))
		expect(emitted.at(-1)).toEqual(["b"])
	})

	test("emits a ready collection once, then once per change", async () => {
		const collection = createCollection(
			localOnlyCollectionOptions<{ id: string; name: string }>({
				getKey: (row) => row.id,
				initialData: [{ id: "a", name: "Platform" }],
			}),
		)
		const emitted: Array<ReadonlyArray<string>> = []
		const fiber = Effect.runFork(
			Stream.runForEach(
				liveQueryStream(
					(q) => q.from({ d: collection }),
					(rows) => Arr.map(rows, (row) => row.id),
				),
				(ids) => Effect.sync(() => emitted.push(ids)),
			),
		)
		await settle()
		collection.insert({ id: "b", name: "Checkout" })
		await settle()
		await Effect.runPromise(Fiber.interrupt(fiber))
		expect(emitted).toEqual([["a"], ["a", "b"]])
	})
})
