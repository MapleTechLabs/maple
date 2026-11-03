import { describe, expect, it } from "@effect/vitest"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { Effect } from "effect"
import { DashboardWriteError, settled } from "./store"

interface Row {
	readonly id: string
}

/** A collection whose delete handler does what `onDelete` says: the write path a dashboard delete takes. */
const collectionWith = (onDelete: () => Promise<void>) =>
	createCollection(
		localOnlyCollectionOptions<Row, string>({
			getKey: (row) => row.id,
			initialData: [{ id: "dash_1" }],
			onDelete,
		}),
	)

/** What the Electric collection rejects with when a txid await times out. */
const txidTimeout = () =>
	Object.assign(new Error("Timeout waiting for txId: 42"), { name: "TimeoutWaitingForTxIdError" })

describe("settled over a real transaction", () => {
	it.effect("reports Synced when the write succeeds", () =>
		Effect.gen(function* () {
			const transaction = collectionWith(async () => {}).delete("dash_1")
			expect(yield* settled(() => transaction.when("settled"))).toBe("Synced")
		}),
	)

	it.effect("fails with the server's message when the write is rejected", () =>
		Effect.gen(function* () {
			const transaction = collectionWith(() => Promise.reject(new Error("Dashboard is locked"))).delete(
				"dash_1",
			)
			const error = yield* Effect.flip(settled(() => transaction.when("settled")))
			expect(error).toBeInstanceOf(DashboardWriteError)
			expect(error.message).toBe("Dashboard is locked")
		}),
	)

	it.effect("reports Behind when only this tab's txid sync-back timed out", () =>
		Effect.gen(function* () {
			const transaction = collectionWith(() => Promise.reject(txidTimeout())).delete("dash_1")
			expect(yield* settled(() => transaction.when("settled"))).toBe("Behind")
		}),
	)
})
