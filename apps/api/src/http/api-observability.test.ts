import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpMiddleware, HttpServerRequest } from "effect/http"
import { ApiObservabilityLive } from "./api-observability"

const tracedFor = (url: string, method = "GET") =>
	Effect.gen(function* () {
		const disabled = yield* HttpMiddleware.TracerDisabledWhen
		return !disabled(HttpServerRequest.fromWeb(new Request(`https://api.maple.dev${url}`, { method })))
	}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

describe("ApiObservabilityLive", () => {
	it("records no server span for a heartbeat ping, whose path carries the token", () => {
		expect(tracedFor("/hb/abc123secret")).toBe(false)
		expect(tracedFor("/hb/abc123secret/fail", "POST")).toBe(false)
	})

	it("still traces ordinary API routes", () => {
		expect(tracedFor("/api/v2/uptime_monitors")).toBe(true)
		expect(tracedFor("/hbx")).toBe(true)
	})
})
