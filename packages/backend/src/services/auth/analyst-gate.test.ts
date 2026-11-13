import { assert, describe, expect, it } from "@effect/vitest"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Exit } from "effect"
import { checkAnalystAccess, checkAnalystAccessV2 } from "./analyst-gate"

const ANALYST = ["org:analyst"]
const MEMBER = ["org:member"]

const errors = MapleInternalApi.groups.errors
const transition = { group: errors, endpoint: errors.endpoints.transitionIssue }
const queries = MapleInternalApi.groups.queryEngine
const traces = MapleApiV2.groups.traces
const dashboards = MapleApiV2.groups.dashboards
const slos = MapleApiV2.groups.slos

/** Whether the gate let the call through. */
const allowed = <E>(gate: Effect.Effect<void, E>) => Effect.map(Effect.exit(gate), Exit.isSuccess)

describe("checkAnalystAccess", () => {
	it.effect("refuses an analyst an issue transition and says how to get it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(checkAnalystAccess(ANALYST, transition))
			assert.instanceOf(error, CurrentTenant.LimitedRoleError)
			expect(error.message).toContain("Ask an org admin for the Member role")
		}),
	)

	it.effect("lets a member, and Maple's own agents with no roles, make the same change", () =>
		Effect.gen(function* () {
			expect(yield* allowed(checkAnalystAccess(MEMBER, transition))).toBe(true)
			expect(yield* allowed(checkAnalystAccess([], transition))).toBe(true)
		}),
	)

	it.effect("lets an analyst run a dashboard query", () =>
		Effect.gen(function* () {
			const query = { group: queries, endpoint: queries.endpoints.executeBatch }
			expect(yield* allowed(checkAnalystAccess(ANALYST, query))).toBe(true)
		}),
	)
})

describe("checkAnalystAccessV2", () => {
	const create = { group: dashboards, endpoint: dashboards.endpoints.create }

	it.effect("lets an analyst search traces, which the scope registry names as a read", () =>
		Effect.gen(function* () {
			const search = { group: traces, endpoint: traces.endpoints.search }
			expect(yield* allowed(checkAnalystAccessV2(ANALYST, search, "/v2/traces/search"))).toBe(true)
		}),
	)

	it.effect("lets an analyst create a dashboard and publish a share link for it", () =>
		Effect.gen(function* () {
			const share = { group: dashboards, endpoint: dashboards.endpoints.upsertShare }
			expect(yield* allowed(checkAnalystAccessV2(ANALYST, create, "/v2/dashboards"))).toBe(true)
			expect(yield* allowed(checkAnalystAccessV2(ANALYST, share, "/v2/dashboards/:id/share"))).toBe(
				true,
			)
		}),
	)

	it.effect("refuses an analyst a new SLO and lets a member create one", () =>
		Effect.gen(function* () {
			const slo = { group: slos, endpoint: slos.endpoints.create }
			const error = yield* Effect.flip(checkAnalystAccessV2(ANALYST, slo, "/v2/slos"))
			expect(error.message).toContain("Analysts can read Maple and build dashboards")
			expect(yield* allowed(checkAnalystAccessV2(MEMBER, slo, "/v2/slos"))).toBe(true)
		}),
	)
})
