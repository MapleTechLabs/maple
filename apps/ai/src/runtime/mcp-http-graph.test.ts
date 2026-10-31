import { describe, expect, it } from "vitest"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import type { HttpEffect } from "alchemy/Http"
import { Context, Effect, Schema, Scope } from "effect"
import { buildApp, buildMcpApp, makeFetch } from "../worker/http"
import { offlinePorts } from "../../test/offline-http-ports"

class UnexpectedGraphBuild extends Schema.TaggedError<UnexpectedGraphBuild>()("UnexpectedGraphBuild", {
	message: Schema.String,
}) {}

const serve = (fetch: HttpEffect, method: string, path: string, body?: string) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const responseEffect: Effect.Effect<Response, never, Scope.Scope> =
					Cloudflare.Workers.makeRequestHandler(fetch)({
						kind: "Cloudflare.Workers.WorkerEvent",
						type: "fetch",
						input: new Request(`http://ai.maple.test${path}`, {
							method,
							headers: {
								"content-type": "application/json",
								accept: "application/json, text/event-stream",
							},
							body,
						}),
					})!
				const response = yield* responseEffect
				return {
					status: response.status,
					challenge: response.headers.get("www-authenticate") !== null,
				}
			}),
		).pipe(Effect.provide(offlinePorts)),
	)

const initialize = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
})

describe("the maple-ai route graphs", () => {
	it("answers /mcp from its own graph without building the other routes", async () => {
		const mcpApp = buildMcpApp(Context.empty(), offlinePorts)
		const rest = Effect.fail(new UnexpectedGraphBuild({ message: "a /mcp request built the rest graph" }))
		const fetch = await Effect.runPromise(
			makeFetch(rest, offlinePorts, mcpApp).pipe(Effect.provide(IsolateAge.layer)),
		)

		const unauthenticated = await serve(fetch, "POST", "/mcp", initialize)
		expect({ status: unauthenticated.status, challenge: unauthenticated.challenge }).toEqual({
			status: 401,
			challenge: true,
		})
		// The rest graph is still what every other path selects.
		expect((await serve(fetch, "GET", "/internal/mcp/tools")).status).toBe(503)
	})

	it("serves the other routes from the rest graph without building /mcp", async () => {
		const app = buildApp(Context.empty(), offlinePorts)
		const mcp = Effect.fail(
			new UnexpectedGraphBuild({ message: "a catalog request built the /mcp graph" }),
		)
		const fetch = await Effect.runPromise(
			makeFetch(app, offlinePorts, mcp).pipe(Effect.provide(IsolateAge.layer)),
		)

		// Session-only, so unauthenticated it is the rest graph's 401: not `/mcp`'s 404, nor a 503.
		expect((await serve(fetch, "GET", "/internal/mcp/tools")).status).toBe(401)
		expect((await serve(fetch, "POST", "/mcp", initialize)).status).toBe(503)
	})
})
