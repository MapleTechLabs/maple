import { assert, describe, expect, it } from "@effect/vitest"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Exit } from "effect"
import { refuseAnalystWrites, refuseAnalystWritesV2 } from "./analyst-gate"

const ANALYST = ["org:analyst"]
const MEMBER = ["org:member"]

const errors = MapleInternalApi.groups.errors
const transition = { group: errors, endpoint: errors.endpoints.transitionIssue }
const queries = MapleInternalApi.groups.queryEngine
const traces = MapleApiV2.groups.traces
const dashboards = MapleApiV2.groups.dashboards

/** Whether the gate let the call through. */
const allowed = <E>(gate: Effect.Effect<void, E>) => Effect.map(Effect.exit(gate), Exit.isSuccess)

describe("refuseAnalystWrites", () => {
	it.effect("refuses an analyst an issue transition and says how to get it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(refuseAnalystWrites(ANALYST, transition))
			assert.instanceOf(error, CurrentTenant.ReadOnlyRoleError)
			expect(error.message).toContain("Ask an org admin for the Member role")
		}),
	)

	it.effect("lets a member, and Maple's own agents with no roles, make the same change", () =>
		Effect.gen(function* () {
			expect(yield* allowed(refuseAnalystWrites(MEMBER, transition))).toBe(true)
			expect(yield* allowed(refuseAnalystWrites([], transition))).toBe(true)
		}),
	)

	it.effect("lets an analyst run a dashboard query", () =>
		Effect.gen(function* () {
			const query = { group: queries, endpoint: queries.endpoints.executeBatch }
			expect(yield* allowed(refuseAnalystWrites(ANALYST, query))).toBe(true)
		}),
	)
})

describe("refuseAnalystWritesV2", () => {
	const create = { group: dashboards, endpoint: dashboards.endpoints.create }

	it.effect("lets an analyst search traces, which the scope registry names as a read", () =>
		Effect.gen(function* () {
			const search = { group: traces, endpoint: traces.endpoints.search }
			expect(yield* allowed(refuseAnalystWritesV2(ANALYST, search, "/v2/traces/search"))).toBe(true)
		}),
	)

	it.effect("refuses an analyst a new dashboard and lets a member create one", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(refuseAnalystWritesV2(ANALYST, create, "/v2/dashboards"))
			expect(error.message).toContain("Analysts can read Maple")
			expect(yield* allowed(refuseAnalystWritesV2(MEMBER, create, "/v2/dashboards"))).toBe(true)
		}),
	)
})
