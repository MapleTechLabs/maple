import { assert, describe, expect, it } from "@effect/vitest"
import { type CalledEndpoint, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Context, Effect, Exit } from "effect"
import { checkEndpointAccess, checkEndpointAccessV2 } from "./endpoint-gate"

const errors = MapleInternalApi.groups.errors
const transition: CalledEndpoint = { group: errors, endpoint: errors.endpoints.transitionIssue }

/** An endpoint nobody has decided anything about yet. */
const unmarked = (method: string): CalledEndpoint => ({
	group: { annotations: Context.empty() },
	endpoint: { method, annotations: Context.empty() },
})

const allowed = <E>(gate: Effect.Effect<void, E>) => Effect.map(Effect.exit(gate), Exit.isSuccess)

describe("checkEndpointAccess", () => {
	it.effect("refuses a missing permission and names it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				checkEndpointAccess(Policy.grantsOf(["org:analyst"]), transition),
			)
			assert.instanceOf(error, CurrentTenant.LimitedRoleError)
			expect(error.message).toBe(Policy.denialFor("error_issues:triage").message)
			expect(yield* allowed(checkEndpointAccess(Policy.grantsOf(["org:member"]), transition))).toBe(
				true,
			)
		}),
	)

	it.effect(
		"refuses an unmarked write to everyone, admins included, and lets an unmarked GET through with telemetry:read",
		() =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(checkEndpointAccess(Policy.allPermissions, unmarked("POST")))
				expect(error.message).toBe(Policy.limitedAccessMessage)
				expect(yield* allowed(checkEndpointAccess(["telemetry:read"], unmarked("GET")))).toBe(true)
				expect(yield* allowed(checkEndpointAccess(["billing:manage"], unmarked("GET")))).toBe(false)
			}),
	)
})

describe("checkEndpointAccessV2", () => {
	it.effect("reads an unmarked POST the scope registry calls a read as needing telemetry:read", () =>
		Effect.gen(function* () {
			const search = unmarked("POST")
			expect(
				yield* allowed(checkEndpointAccessV2(["telemetry:read"], search, "/v2/traces/search")),
			).toBe(true)
			const error = yield* Effect.flip(checkEndpointAccessV2([], search, "/v2/traces/search"))
			expect(error.message).toBe(Policy.denialFor("telemetry:read").message)
		}),
	)

	it.effect("refuses any other unmarked write", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				checkEndpointAccessV2(Policy.allPermissions, unmarked("POST"), "/v2/slos"),
			)
			expect(error.message).toBe(Policy.limitedAccessMessage)
		}),
	)
})
