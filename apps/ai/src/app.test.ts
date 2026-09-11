import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { fetch } from "./app"

const respondTo = (method: string, url: string) =>
	Effect.runPromise(
		fetch.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(new Request(`https://maple-ai.internal${url}`, { method })),
			),
		),
	)

describe("the AI worker's request surface", () => {
	it("answers /health without building a service graph", async () => {
		const response = await respondTo("GET", "/health")
		expect(response.status).toBe(200)
	})

	it("404s every other path, so a route that should be served and is not stays visible", async () => {
		for (const path of ["/", "/mcp", "/api/chat/sessions/o:t/events"]) {
			expect((await respondTo("GET", path)).status).toBe(404)
		}
	})

	it("does not answer /health for a non-GET", async () => {
		expect((await respondTo("POST", "/health")).status).toBe(404)
	})
})
