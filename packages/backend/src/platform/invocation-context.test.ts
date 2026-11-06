import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Scope } from "effect"
import { captureReusableContext } from "./invocation-context"
import { DrainRunOnInterrupt, PgConnectionScope, type PgConnectionScopeApi } from "./pg-connection-scope"

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("@maple/test/Greeting") {}

const scopeNamed = (name: string): PgConnectionScopeApi & { readonly name: string } => ({
	name,
	run: () => Effect.die(name),
	close: Effect.void,
})

describe("captureReusableContext", () => {
	it.effect("keeps services but lets the later invocation's own scope, drain flag and Scope win", () =>
		Effect.gen(function* () {
			const constructionScope = scopeNamed("construction")
			const requestScope = scopeNamed("request")
			const constructionResource = yield* Scope.make()

			const captured = yield* captureReusableContext<Greeting>().pipe(
				Effect.provideService(Greeting, { text: "hello" }),
				Effect.provideService(PgConnectionScope, constructionScope),
				Effect.provideService(DrainRunOnInterrupt, true),
				Effect.provideService(Scope.Scope, constructionResource),
			)

			const requestResource = yield* Scope.make()
			const seen = yield* Effect.all({
				greeting: Effect.map(Greeting, (greeting) => greeting.text),
				pgScope: PgConnectionScope,
				drain: DrainRunOnInterrupt,
				scope: Scope.Scope,
			}).pipe(
				Effect.provide(captured),
				Effect.provideService(PgConnectionScope, requestScope),
				Effect.provideService(Scope.Scope, requestResource),
			)

			expect(seen).toEqual({
				greeting: "hello",
				pgScope: requestScope,
				drain: false,
				scope: requestResource,
			})
		}),
	)
})
