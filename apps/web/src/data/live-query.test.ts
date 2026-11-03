import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { releaseLiveQuery } from "./live-query"

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
