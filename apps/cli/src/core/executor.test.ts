// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import { test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { rawCompiledQuery } from "@maple/query-engine/ch"
import { makeLocalWarehouseExecutorApi } from "./executor"

// The local executor is the REAL makeWarehouseExecutor wired to the `chdb`
// backend — these tests pin the wiring: SQL normalization for the local
// server, row flow, and the OrgId scoping guard.

const BASE_URL = "http://127.0.0.1:4318"

/** An HttpClient whose transport is the given fetch stand-in. */
const httpWith = (request: typeof fetch) =>
	FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)))

const stubFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch

// The Effect HttpClient hands fetch a `Uint8Array` body, so decode rather than stringify.
const bodyText = (body: RequestInit["body"]) =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "{}")

const stubLocalServer = (rows: ReadonlyArray<Record<string, unknown>>) => {
	const requests: Array<{ url: string; sql: string }> = []
	const request = stubFetch((url, init) => {
		const body = JSON.parse(bodyText(init?.body)) as { sql?: string }
		requests.push({ url, sql: body.sql ?? "" })
		return new Response(JSON.stringify(rows), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	})
	return { requests, request }
}

describe("makeLocalWarehouseExecutorApi", () => {
	it.effect("posts compiled SQL to /local/query with the trailing FORMAT stripped (chdb dialect)", () => {
		const { requests, request } = stubLocalServer([{ c: 1 }])
		return Effect.gen(function* () {
			const executor = yield* makeLocalWarehouseExecutorApi(BASE_URL)
			const compiled = rawCompiledQuery<{ readonly c: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count() AS c FROM traces WHERE OrgId = 'local'\nFORMAT JSON",
			})

			const rows = yield* executor.compiledQuery(compiled)

			expect(rows).toEqual([{ c: 1 }])
			expect(requests).toHaveLength(1)
			expect(requests[0]!.url).toBe(`${BASE_URL}/local/query`)
			// The chdb backend speaks the ClickHouse protocol shape: the executor
			// strips the trailing FORMAT and the local server owns the output format.
			expect(requests[0]!.sql).not.toContain("FORMAT JSON")
			expect(requests[0]!.sql).toContain("OrgId = 'local'")
		}).pipe(Effect.provide(httpWith(request)))
	})

	it.effect("keeps the executor's OrgId scoping guard for trusted SQL", () => {
		const { request } = stubLocalServer([])
		return Effect.gen(function* () {
			const executor = yield* makeLocalWarehouseExecutorApi(BASE_URL)

			// Scope now rides on the compiled query rather than being sniffed out
			// of the SQL string, so an unscoped one is rejected before execution.
			const exit = yield* executor
				.compiledQuery(
					rawCompiledQuery({
						reason: "test-fixture",
						justification:
							"Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: "SELECT 1",
						tenantScope: "cross-tenant",
					}),
				)
				.pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
		}).pipe(Effect.provide(httpWith(request)))
	})

	it.effect("classifies a local 400 query failure without retrying it", () => {
		let attempts = 0
		const request = stubFetch(() => {
			attempts += 1
			return new Response("query failed: Unknown expression identifier", { status: 400 })
		})
		return Effect.gen(function* () {
			const executor = yield* makeLocalWarehouseExecutorApi(BASE_URL)

			const exit = yield* executor
				.compiledQuery(
					rawCompiledQuery({
						reason: "test-fixture",
						justification:
							"Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: "SELECT nope FROM traces WHERE OrgId = 'local'",
						tenantScope: "single-tenant",
					}),
				)
				.pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			// 400 is a non-transient client-side failure — exactly one attempt.
			expect(attempts).toBe(1)
		}).pipe(Effect.provide(httpWith(request)))
	})

	// A plain bun test: under `bun test`, `@effect/vitest`'s wrapper never settles
	// once a forked fiber has been interrupted inside `Effect.tryPromise` (the
	// fetch), even though the fiber itself completes. `Effect.runPromise` directly
	// does not have that problem.
	test("interrupting local execution aborts the chDB request", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const started = yield* Deferred.make<AbortSignal>()
				const request = ((_input: string | Request | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal
						if (!signal) throw new Error("Expected cancellation signal")
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
						Deferred.doneUnsafe(started, Effect.succeed(signal))
					})) as typeof fetch
				const executor = yield* makeLocalWarehouseExecutorApi(BASE_URL).pipe(
					Effect.provide(httpWith(request)),
				)
				const query = rawCompiledQuery({
					reason: "test-fixture",
					justification: "Verify local transport cancellation.",
					tenantScope: "single-tenant",
					sql: "SELECT 1 FROM traces WHERE OrgId = 'local'",
				})
				const fiber = yield* Effect.forkChild(executor.compiledQuery(query))
				const signal = yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				expect(signal.aborted).toBe(true)
			}),
		),
	)
})
