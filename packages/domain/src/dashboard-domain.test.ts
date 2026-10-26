import { describe, expect, it } from "vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { InMemory } from "@alchemy.run/domain/InMemory"
import { DashboardId, OrgId } from "./primitives"
import {
	dashboardDomainKey,
	DashboardNameModel,
	DashboardNames,
	DashboardNameView,
	ImportDashboardName,
	RenameDashboard,
} from "./dashboard-domain"

const key = (org = "org-a") => dashboardDomainKey(OrgId.make(org), DashboardId.make("dash-1"))
const layer = DashboardNameModel.layer(Layer.empty).pipe(Layer.provide(InMemory))

const initialized = Effect.gen(function* () {
	const names = yield* DashboardNames
	yield* names.send(key(), new ImportDashboardName({ name: "Operations" }))
	return names
})

describe("dashboard name domain", () => {
	it("records semantic renames, confirms the view, and reconnects at the latest name", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const names = yield* initialized
					const view = yield* DashboardNameView
					const receipt = yield* names.send(key(), new RenameDashboard({ name: "Production" }))
					expect(receipt.events.map((event) => event._tag)).toEqual(["DashboardRenamed"])
					expect(yield* view.query(DashboardNames.ref(key()), { atLeast: receipt })).toEqual(
						Option.some("Production"),
					)
					const connected = yield* Stream.runCollect(
						view.watch(DashboardNames.ref(key())).pipe(Stream.take(1)),
					)
					expect(Array.from(connected)).toEqual([Option.some("Production")])
					const next = yield* names.send(key(), new RenameDashboard({ name: "Service health" }))
					yield* view.query(DashboardNames.ref(key()), { atLeast: next })
					const reconnected = yield* Stream.runCollect(
						view.watch(DashboardNames.ref(key())).pipe(Stream.take(1)),
					)
					expect(Array.from(reconnected)).toEqual([Option.some("Service health")])
				}).pipe(Effect.provide(layer)),
			),
		)
	})

	it("serializes concurrent clients and returns the original duplicate command receipt", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const names = yield* initialized
					const receipts = yield* Effect.all(
						[
							names.send(key(), new RenameDashboard({ name: "First client" }), {
								commandId: "first",
							}),
							names.send(key(), new RenameDashboard({ name: "Second client" }), {
								commandId: "second",
							}),
						],
						{ concurrency: "unbounded" },
					)
					expect(receipts.map((receipt) => receipt.version).sort()).toEqual([2, 3])
					const latest = receipts.reduce((a, b) => (a.version > b.version ? a : b))
					expect(yield* names.state(key())).toBe(latest.events[0]?.name)
					const duplicate = yield* names.send(
						key(),
						new RenameDashboard({ name: "Ignored retry payload" }),
						{ commandId: "first" },
					)
					expect(duplicate).toEqual(receipts[0])
					expect(yield* names.state(key())).toBe(latest.events[0]?.name)
				}).pipe(Effect.provide(layer)),
			),
		)
	})

	it("rejects missing/bootstrap conflicts, keeps no-op versions stable, and isolates tenant keys", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const names = yield* initialized
					const missing = yield* Effect.flip(
						names.send(key("org-b"), new RenameDashboard({ name: "Other tenant" })),
					)
					expect(missing._tag).toBe("@maple/dashboard/NameMissing")
					const conflict = yield* Effect.flip(
						names.send(key(), new ImportDashboardName({ name: "Stale bootstrap" })),
					)
					expect(conflict._tag).toBe("@maple/dashboard/NameAlreadyImported")
					const receipt = yield* names.send(key(), new RenameDashboard({ name: "Operations" }))
					expect(receipt.events).toEqual([])
					expect(receipt.version).toBe(1)
					yield* names.send(key("org-b"), new ImportDashboardName({ name: "Other tenant" }))
					expect(yield* names.state(key())).toBe("Operations")
					expect(yield* names.state(key("org-b"))).toBe("Other tenant")
				}).pipe(Effect.provide(layer)),
			),
		)
	})
})
