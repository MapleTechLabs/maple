import { describe, expect, it } from "@effect/vitest"
import * as Policy from "@maple/domain/policy"
import { Effect, Ref } from "effect"
import { type AccessDenial, watchHandlerAccess } from "./access-span"

const forbidden = (denial: Policy.Denial) => denial.message

/** A handler whose service checks `permission` inside a span of its own. */
const handler = (grants: Policy.Grants, permission: Policy.Permission) =>
	Policy.check(grants, permission, forbidden).pipe(Effect.withSpan("AlertRulesService.requirePermission"))

const accessOf = (span: { readonly attributes: ReadonlyMap<string, unknown> }) => ({
	outcome: span.attributes.get("maple.access.outcome"),
	site: span.attributes.get("maple.access.site"),
	permission: span.attributes.get("maple.access.permission"),
})

describe("watchHandlerAccess", () => {
	it.effect("marks the request's span, not the service's, when a handler check refuses", () =>
		Effect.gen(function* () {
			const denials = yield* Ref.make<ReadonlyArray<AccessDenial>>([])
			const refused = yield* Effect.flip(
				handler(["telemetry:read"], "alerts:manage").pipe(
					watchHandlerAccess((denial) => Ref.update(denials, (seen) => [...seen, denial])),
				),
			)
			expect(refused).toBe(Policy.denialFor("alerts:manage").message)
			expect(accessOf(yield* Effect.currentSpan)).toEqual({
				outcome: "denied",
				site: "handler",
				permission: "alerts:manage",
			})
			expect(yield* Ref.get(denials)).toEqual([Policy.denialFor("alerts:manage")])
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("leaves the span as the gate marked it when every handler check holds", () =>
		Effect.gen(function* () {
			const denials = yield* Ref.make(0)
			yield* handler(["alerts:manage"], "alerts:manage").pipe(
				watchHandlerAccess(() => Ref.update(denials, (count) => count + 1)),
			)
			expect(accessOf(yield* Effect.currentSpan).outcome).toBeUndefined()
			expect(yield* Ref.get(denials)).toBe(0)
		}).pipe(Effect.withSpan("http.server")),
	)
})
