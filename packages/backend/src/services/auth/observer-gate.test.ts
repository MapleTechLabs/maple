import { assert, describe, expect, it } from "@effect/vitest"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Exit } from "effect"
import { refuseObserverWrites, refuseObserverWritesV2 } from "./observer-gate"

const OBSERVER = ["org:observer"]
const MEMBER = ["org:member"]

const errors = MapleInternalApi.groups.errors
const transition = { group: errors, endpoint: errors.endpoints.transitionIssue }
const queries = MapleInternalApi.groups.queryEngine
const traces = MapleApiV2.groups.traces
const dashboards = MapleApiV2.groups.dashboards

/** Whether the gate let the call through. */
const allowed = <E>(gate: Effect.Effect<void, E>) => Effect.map(Effect.exit(gate), Exit.isSuccess)

describe("refuseObserverWrites", () => {
	it.effect("refuses an observer an issue transition and says how to get it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(refuseObserverWrites(OBSERVER, transition))
			assert.instanceOf(error, CurrentTenant.ReadOnlyRoleError)
			expect(error.message).toContain("Ask an org admin for the Member role")
		}),
	)

	it.effect("lets a member, and Maple's own agents with no roles, make the same change", () =>
		Effect.gen(function* () {
			expect(yield* allowed(refuseObserverWrites(MEMBER, transition))).toBe(true)
			expect(yield* allowed(refuseObserverWrites([], transition))).toBe(true)
		}),
	)

	it.effect("lets an observer run a dashboard query", () =>
		Effect.gen(function* () {
			const query = { group: queries, endpoint: queries.endpoints.executeBatch }
			expect(yield* allowed(refuseObserverWrites(OBSERVER, query))).toBe(true)
		}),
	)
})

describe("refuseObserverWritesV2", () => {
	const create = { group: dashboards, endpoint: dashboards.endpoints.create }

	it.effect("lets an observer search traces, which the scope registry names as a read", () =>
		Effect.gen(function* () {
			const search = { group: traces, endpoint: traces.endpoints.search }
			expect(yield* allowed(refuseObserverWritesV2(OBSERVER, search, "/v2/traces/search"))).toBe(true)
		}),
	)

	it.effect("refuses an observer a new dashboard and lets a member create one", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(refuseObserverWritesV2(OBSERVER, create, "/v2/dashboards"))
			expect(error.message).toContain("Observers can read Maple")
			expect(yield* allowed(refuseObserverWritesV2(MEMBER, create, "/v2/dashboards"))).toBe(true)
		}),
	)
})
