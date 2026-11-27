import { assert, describe, expect, it } from "@effect/vitest"
import { type CalledEndpoint, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Context, Effect, Exit, Ref } from "effect"
import { checkEndpointAccess, checkEndpointAccessV2 } from "./endpoint-gate"

const errors = MapleInternalApi.groups.errors
const transition: CalledEndpoint = { group: errors, endpoint: errors.endpoints.transitionIssue }

/** An endpoint nobody has decided anything about yet. */
const unmarked = (method: string): CalledEndpoint => ({
	group: { annotations: Context.empty() },
	endpoint: { method, annotations: Context.empty() },
})

/** These cases are about the decision, not about what is recorded. */
const unrecorded = () => Effect.void

const allowed = <E>(gate: Effect.Effect<void, E>) => Effect.map(Effect.exit(gate), Exit.isSuccess)

describe("checkEndpointAccess", () => {
	it.effect("refuses a missing permission and names it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				checkEndpointAccess(Policy.grantsOf(["org:analyst"]), transition, unrecorded),
			)
			assert.instanceOf(error, CurrentTenant.LimitedRoleError)
			expect(error.message).toBe(Policy.denialFor("error_issues:triage").message)
			expect(
				yield* allowed(checkEndpointAccess(Policy.grantsOf(["org:member"]), transition, unrecorded)),
			).toBe(true)
		}),
	)

	it.effect(
		"refuses an unmarked write to everyone, admins included, and lets an unmarked GET through with telemetry:read",
		() =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					checkEndpointAccess(Policy.allPermissions, unmarked("POST"), unrecorded),
				)
				expect(error.message).toBe(Policy.limitedAccessMessage)
				expect(
					yield* allowed(checkEndpointAccess(["telemetry:read"], unmarked("GET"), unrecorded)),
				).toBe(true)
				expect(
					yield* allowed(checkEndpointAccess(["billing:manage"], unmarked("GET"), unrecorded)),
				).toBe(false)
			}),
	)
})

describe("a role limited to namespaces at the gate", () => {
	const limited: Policy.Grants = [Policy.SCOPED_READ, "devices:connect"]

	// "You need Read telemetry" would send it to ask for the one thing its role replaces.
	it.effect("is told its role is limited, not to get Read telemetry", () =>
		Effect.gen(function* () {
			const internal = yield* Effect.flip(checkEndpointAccess(limited, unmarked("GET"), unrecorded))
			expect(internal.message).toBe(Policy.scopedAccessMessage)
			const v2 = yield* Effect.flip(
				checkEndpointAccessV2(limited, unmarked("POST"), "/v2/traces/search", unrecorded),
			)
			expect(v2.message).toBe(Policy.scopedAccessMessage)
		}),
	)

	it.effect("is still told which other permission it lacks", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				checkEndpointAccess([...limited, "telemetry:read"], transition, unrecorded),
			)
			expect(error.message).toBe(Policy.denialFor("error_issues:triage").message)
		}),
	)
})

describe("checkEndpointAccessV2", () => {
	it.effect("reads an unmarked POST the scope registry calls a read as needing telemetry:read", () =>
		Effect.gen(function* () {
			const search = unmarked("POST")
			expect(
				yield* allowed(
					checkEndpointAccessV2(["telemetry:read"], search, "/v2/traces/search", unrecorded),
				),
			).toBe(true)
			const error = yield* Effect.flip(
				checkEndpointAccessV2([], search, "/v2/traces/search", unrecorded),
			)
			expect(error.message).toBe(Policy.denialFor("telemetry:read").message)
		}),
	)

	it.effect("refuses any other unmarked write", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				checkEndpointAccessV2(Policy.allPermissions, unmarked("POST"), "/v2/slos", unrecorded),
			)
			expect(error.message).toBe(Policy.limitedAccessMessage)
		}),
	)
})

describe("what the gate leaves on the request's span", () => {
	const accessOf = Effect.map(Effect.currentSpan, (span) => ({
		outcome: span.attributes.get("maple.access.outcome"),
		site: span.attributes.get("maple.access.site"),
		permission: span.attributes.get("maple.access.permission"),
	}))

	it.effect("an allowed call", () =>
		Effect.gen(function* () {
			yield* checkEndpointAccess(Policy.grantsOf(["org:member"]), transition, unrecorded)
			expect(yield* accessOf).toEqual({ outcome: "allowed", site: "edge", permission: undefined })
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("a refused call names the missing permission, and hands the refusal on before failing", () =>
		Effect.gen(function* () {
			const handed = yield* Ref.make<ReadonlyArray<unknown>>([])
			yield* Effect.flip(
				checkEndpointAccess(Policy.grantsOf(["org:analyst"]), transition, (denial) =>
					Ref.update(handed, (seen) => [...seen, denial]),
				),
			)
			expect(yield* accessOf).toEqual({
				outcome: "denied",
				site: "edge",
				permission: "error_issues:triage",
			})
			expect(yield* Ref.get(handed)).toEqual([
				{
					permission: "error_issues:triage",
					message: Policy.denialFor("error_issues:triage").message,
				},
			])
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("a write nobody marked is told apart from a missing permission", () =>
		Effect.gen(function* () {
			yield* Effect.flip(
				checkEndpointAccessV2(Policy.allPermissions, unmarked("POST"), "/v2/slos", unrecorded),
			)
			expect(yield* accessOf).toEqual({ outcome: "unmarked", site: "edge", permission: undefined })
		}).pipe(Effect.withSpan("http.server")),
	)
})
