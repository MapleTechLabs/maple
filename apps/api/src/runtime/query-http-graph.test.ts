import { makeLoginSelfHosted } from "@maple/auth"
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Option, Redacted, Scope } from "effect"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { buildApp, makeAppGraphs } from "../worker/http"
import { offlinePorts } from "../../test/offline-http-ports"

const request = (handler: HttpEffect, path: string, headers?: Record<string, string>) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const responseEffect: Effect.Effect<Response, never, Scope.Scope> =
					Cloudflare.Workers.makeRequestHandler(handler)({
						kind: "Cloudflare.Workers.WorkerEvent",
						type: "fetch",
						input: new Request(`http://api.test${path}`, {
							method: "POST",
							headers: { "content-type": "application/json", ...headers },
							body: "{}",
						}),
					})!
				const response = yield* responseEffect
				return {
					status: response.status,
					cors: response.headers.get("access-control-allow-origin"),
					body: yield* Effect.promise(() => response.text()),
				}
			}),
		).pipe(Effect.provide(offlinePorts)),
	)

describe("dashboard query graph", () => {
	it("builds both cold graphs concurrently without losing routes", async () => {
		const graphs = await Effect.runPromise(makeAppGraphs(Context.empty(), offlinePorts))
		const [full, query] = await Promise.all([
			Effect.runPromise(graphs.app),
			Effect.runPromise(graphs.queryApp),
		])
		expect(await request(full, "/internal/query-engine/execute-batch")).toEqual(
			await request(query, "/internal/query-engine/execute-batch"),
		)
		expect(await Effect.runPromise(graphs.app)).toBe(full)
		expect(await Effect.runPromise(graphs.queryApp)).toBe(query)
	})

	it("preserves auth and error responses in either graph build order", async () => {
		const session = await Effect.runPromise(
			makeLoginSelfHosted({
				MAPLE_AUTH_MODE: "self_hosted",
				MAPLE_DEFAULT_ORG_ID: "default",
				MAPLE_ROOT_PASSWORD: Option.some(Redacted.make("offline-benchmark-only")),
			})("offline-benchmark-only"),
		)
		for (const order of [
			["query", "full"],
			["full", "query"],
		] as const) {
			const memo = Layer.makeMemoMapUnsafe()
			const first = await Effect.runPromise(buildApp(Context.empty(), offlinePorts, order[0], memo))
			const second = await Effect.runPromise(buildApp(Context.empty(), offlinePorts, order[1], memo))
			for (const path of [
				"/internal/query-engine/execute-batch",
				"/internal/query-engine/not-a-route",
			]) {
				for (const headers of [
					undefined,
					{ authorization: "Bearer maple_ak_rejected" },
					{ authorization: `Bearer ${session.token}` },
				]) {
					const a = await request(first, path, headers)
					const b = await request(second, path, headers)
					expect(a).toEqual(b)
					expect(a.status).toBe(
						path.endsWith("not-a-route")
							? 404
							: headers
								? headers.authorization.startsWith("Bearer maple_ak_")
									? 403
									: 400
								: 401,
					)
				}
			}
		}
	})
})
