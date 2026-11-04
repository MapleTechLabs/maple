import { describe, expect, it } from "@effect/vitest"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { DashboardConcurrencyError, DashboardId } from "@maple/domain/http"
import type { DashboardRow } from "@maple/web-data/collections/dashboards"
import { Effect } from "effect"
import { DashboardConflictError, DashboardWriteError, mutateDocumentIn, settled } from "./store"

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

describe("mutateDocumentIn when someone else saved first", () => {
	const ID = "3f1b7c62-5a1e-4d0f-9a3b-6c2e8d4f1a90"
	const payload = (name: string, tags: ReadonlyArray<string>) => ({
		id: ID,
		schemaVersion: 3,
		name,
		tags,
		timeRange: { type: "relative", value: "12h" },
		widgets: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	})
	const row = (version: number): DashboardRow => ({
		org_id: "org_1",
		id: ID,
		name: "Board",
		payload_json: payload("Board", []),
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		created_by: "user_a",
		updated_by: "user_a",
		version,
	})
	const conflict = () =>
		new DashboardConcurrencyError({
			dashboardId: DashboardId.make(ID),
			message: "Someone else changed this dashboard since it was loaded.",
		})

	/**
	 * A collection whose first save is refused with a 409 while the other editor's change
	 * (a rename, version 2) syncs in; `afterConflict` answers every save after that.
	 */
	const raced = (afterConflict: () => Promise<void>) => {
		const sent: Array<{ readonly version: number; readonly payload: unknown }> = []
		let calls = 0
		const collection = createCollection(
			localOnlyCollectionOptions<DashboardRow, string>({
				getKey: (r) => r.id,
				initialData: [row(1)],
				onUpdate: ({ transaction }) => {
					calls += 1
					const { original, modified } = transaction.mutations[0]
					if (calls === 1) {
						setTimeout(() =>
							collection.update(ID, (draft) => {
								draft.version = 2
								draft.name = "Renamed elsewhere"
								draft.payload_json = payload("Renamed elsewhere", [])
							}),
						)
						return Promise.reject(conflict())
					}
					// The other editor's change is accepted as it arrives.
					if (modified.name === "Renamed elsewhere" && original.version === 1)
						return Promise.resolve()
					sent.push({ version: original.version, payload: modified.payload_json })
					return afterConflict()
				},
			}),
		)
		return { collection, sent }
	}

	it.effect("waits for the newer version, then re-applies the edit on top of it", () =>
		Effect.gen(function* () {
			const { collection, sent } = raced(async () => {})
			const outcome = yield* mutateDocumentIn(collection, ID, (document, nowIso) => ({
				...document,
				tags: ["prod"],
				updatedAt: nowIso,
			}))

			expect(outcome).toBe("Synced")
			// The retry was based on the other editor's version, and its PATCH keeps their rename.
			expect(sent).toHaveLength(1)
			expect(sent[0]?.version).toBe(2)
			expect(sent[0]?.payload).toMatchObject({ name: "Renamed elsewhere", tags: ["prod"] })
		}),
	)

	it.effect("says the dashboard changed when the retry conflicts too", () =>
		Effect.gen(function* () {
			const { collection } = raced(() => Promise.reject(conflict()))
			const error = yield* Effect.flip(
				mutateDocumentIn(collection, ID, (document, nowIso) => ({
					...document,
					tags: ["prod"],
					updatedAt: nowIso,
				})),
			)

			expect(error).toBeInstanceOf(DashboardConflictError)
			expect(error.message).toContain("This dashboard changed before your edit was saved")
		}),
	)

	it.effect("a tab's own overlapping saves go one at a time, each on the version the last one synced", () =>
		Effect.gen(function* () {
			const seen: Array<number> = []
			let inFlight = 0
			let maxInFlight = 0
			const collection = createCollection(
				localOnlyCollectionOptions<DashboardRow, string>({
					getKey: (r) => r.id,
					initialData: [row(1)],
					onUpdate: async ({ transaction }) => {
						const { original, modified } = transaction.mutations[0]
						// The server's echo of the previous save: its new version syncing in.
						if (modified.version !== original.version) return
						inFlight += 1
						maxInFlight = Math.max(maxInFlight, inFlight)
						seen.push(original.version)
						await new Promise((resolve) => setTimeout(resolve, 5))
						inFlight -= 1
						setTimeout(() =>
							collection.update(ID, (draft) => {
								draft.version = original.version + 1
							}),
						)
					},
				}),
			)
			const tag = (name: string) =>
				mutateDocumentIn(collection, ID, (document, nowIso) => ({
					...document,
					tags: [...(document.tags ?? []), name],
					updatedAt: nowIso,
				}))
			yield* Effect.all([tag("a"), tag("b")], { concurrency: "unbounded" })

			expect(maxInFlight).toBe(1)
			expect(seen).toHaveLength(2)
		}),
	)
})
