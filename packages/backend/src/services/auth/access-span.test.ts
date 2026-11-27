import { describe, expect, it } from "@effect/vitest"
import { type CalledEndpoint, EndpointAccess, handlerChecks, requires } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Context, Effect, Ref } from "effect"
import { type AccessDenial, watchHandlerAccess } from "./access-span"

const forbidden = (denial: Policy.Denial) => denial.message

/** A handler whose service checks `permission` inside a span of its own. */
const handler = (grants: Policy.Grants, permission: Policy.Permission) =>
	Policy.check(grants, permission, forbidden).pipe(Effect.withSpan("AlertRulesService.requirePermission"))

/** A write whose group asks for Read telemetry and whose handler may ask for Manage alerts. */
const alertWrite: CalledEndpoint = {
	group: { annotations: Context.make(EndpointAccess, requires("telemetry:read")) },
	endpoint: { method: "POST", annotations: Context.make(EndpointAccess, handlerChecks("alerts:manage")) },
}

const accessOf = (span: { readonly attributes: ReadonlyMap<string, unknown> }) => ({
	outcome: span.attributes.get("maple.access.outcome"),
	site: span.attributes.get("maple.access.site"),
	permission: span.attributes.get("maple.access.permission"),
	undeclared: span.attributes.get("maple.access.undeclared"),
})

describe("watchHandlerAccess", () => {
	it.effect("marks the request's span, not the service's, when a handler check refuses", () =>
		Effect.gen(function* () {
			const denials = yield* Ref.make<ReadonlyArray<AccessDenial>>([])
			const refused = yield* Effect.flip(
				handler(["telemetry:read"], "alerts:manage").pipe(
					watchHandlerAccess(alertWrite, (denial) =>
						Ref.update(denials, (seen) => [...seen, denial]),
					),
				),
			)
			expect(refused).toBe(Policy.denialFor("alerts:manage").message)
			expect(accessOf(yield* Effect.currentSpan)).toEqual({
				outcome: "denied",
				site: "handler",
				permission: "alerts:manage",
				undeclared: undefined,
			})
			expect(yield* Ref.get(denials)).toEqual([Policy.denialFor("alerts:manage")])
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("leaves the span as the gate marked it when every handler check holds", () =>
		Effect.gen(function* () {
			const denials = yield* Ref.make(0)
			yield* handler(["alerts:manage"], "alerts:manage").pipe(
				watchHandlerAccess(alertWrite, () => Ref.update(denials, (count) => count + 1)),
			)
			expect(accessOf(yield* Effect.currentSpan).outcome).toBeUndefined()
			expect(yield* Ref.get(denials)).toBe(0)
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("names a permission the handler asked that the endpoint does not declare, allowed or not", () =>
		Effect.gen(function* () {
			yield* handler(["query:sql"], "query:sql").pipe(watchHandlerAccess(alertWrite, () => Effect.void))
			expect(accessOf(yield* Effect.currentSpan)).toMatchObject({
				outcome: undefined,
				undeclared: "query:sql",
			})
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("lists every undeclared permission a handler asked, each once", () =>
		Effect.gen(function* () {
			yield* Effect.all([
				handler(["query:sql", "billing:manage"], "query:sql"),
				handler(["query:sql", "billing:manage"], "billing:manage"),
				handler(["query:sql", "billing:manage"], "query:sql"),
			]).pipe(watchHandlerAccess(alertWrite, () => Effect.void))
			expect(accessOf(yield* Effect.currentSpan).undeclared).toBe("query:sql,billing:manage")
		}).pipe(Effect.withSpan("http.server")),
	)

	it.effect("counts what the gate already required as declared", () =>
		Effect.gen(function* () {
			yield* handler(["telemetry:read"], "telemetry:read").pipe(
				watchHandlerAccess(alertWrite, () => Effect.void),
			)
			expect(accessOf(yield* Effect.currentSpan).undeclared).toBeUndefined()
		}).pipe(Effect.withSpan("http.server")),
	)
})
