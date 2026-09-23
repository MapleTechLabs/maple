import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { forkRequestScoped } from "./fork-request-scoped"
import { makeMaplePgClient } from "@maple/db/client"
import {
	makePgConnectionScope,
	PgConnectionScope,
	type PgConnectionScopeApi,
	PgConnectionScopeClosedError,
	withPgConnectionScopeOf,
} from "./pg-connection-scope"
import { toDatabaseError } from "./DatabaseLive"

/**
 * A scope with the real state machine's one property that matters here: once
 * `close()` has run, `run` refuses synchronously instead of dialing. `runs`
 * counts calls that arrived while the scope was still open.
 */
const refusingScope = () => {
	let closed = false
	let runs = 0
	const scope: PgConnectionScopeApi = {
		run: (fn) =>
			Effect.suspend(() => {
				if (closed) {
					return Effect.fail(
						toDatabaseError(new PgConnectionScopeClosedError({ message: "closed" })),
					)
				}
				runs += 1
				return fn(undefined as never)
			}),
		close: Effect.sync(() => {
			closed = true
		}),
	}
	return { scope, runs: () => runs }
}

const dbCall = Effect.gen(function* () {
	const scope = yield* PgConnectionScope
	return yield* scope!.run(() => Effect.succeed("touched"))
})

describe("forkRequestScoped", () => {
	it.live("lets a DB call already under way finish when the request ends", () =>
		Effect.gen(function* () {
			let finished = false
			const scope: PgConnectionScopeApi = makePgConnectionScope("postgres://unused", undefined, {
				openClient: (options) =>
					makeMaplePgClient("postgres://maple:maple@127.0.0.1:1/never", options),
			})

			yield* withPgConnectionScopeOf(
				scope,
				Effect.scoped(
					forkRequestScoped(
						Effect.gen(function* () {
							const current = yield* PgConnectionScope
							// Stands in for a statement waiting on a pool checkout.
							yield* current!.run(() =>
								Effect.sleep("30 millis").pipe(
									Effect.tap(() => Effect.sync(() => (finished = true))),
								),
							)
						}),
					),
				),
			)

			assert.isTrue(finished)
		}),
	)

	it.live("still interrupts forked work that has not reached the database", () =>
		Effect.gen(function* () {
			const { scope, runs } = refusingScope()
			const startedAt = Date.now()

			yield* withPgConnectionScopeOf(
				scope,
				Effect.scoped(forkRequestScoped(Effect.sleep("5 seconds").pipe(Effect.andThen(dbCall)))),
			)

			// The response is not held for work that is not yet a DB call.
			assert.isBelow(Date.now() - startedAt, 1000)
			assert.strictEqual(runs(), 0)
		}),
	)

	// A handler that forks and then finishes with no further async work must
	// still get its background DB call in before the connection scope closes —
	// the shape `ApiKeysService.touchLastUsed` had on `POST /mcp` (it is awaited
	// inline now), which used to land every call as `SCOPE_CLOSED`. The real
	// pool's checkout timing is covered by the Postgres integration suite.
	it.effect("runs the forked DB call before the connection scope closes", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { scope, runs } = refusingScope()
				let outcome: "ok" | "closed" | "unset" = "unset"

				yield* withPgConnectionScopeOf(
					scope,
					Effect.gen(function* () {
						yield* forkRequestScoped(
							dbCall.pipe(
								Effect.tap(() => Effect.sync(() => (outcome = "ok"))),
								Effect.catchTag("@maple/api/lib/DatabaseError", () =>
									Effect.sync(() => (outcome = "closed")),
								),
							),
						)
						// Handler returns synchronously — no await between the fork and
						// the response.
						return "response"
					}),
				)

				assert.strictEqual(runs(), 1)
				assert.strictEqual(outcome, "ok")
			}),
		),
	)

	it.effect("outside any request Scope, forks a child of the calling fiber", () =>
		Effect.gen(function* () {
			const { scope, runs } = refusingScope()
			const fiber = yield* withPgConnectionScopeOf(scope, forkRequestScoped(dbCall))
			// The child is a real fiber the caller can still observe.
			const result = yield* Fiber.join(fiber)
			assert.strictEqual(result, "touched")
			assert.strictEqual(runs(), 1)
		}),
	)
})
